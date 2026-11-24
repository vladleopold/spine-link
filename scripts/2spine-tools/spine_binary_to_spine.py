#!/usr/bin/env python3
"""
Spine binary (.spine binary format saved with .json extension, MessagePack)
to Spine JSON data file converter.

Handles two formats:
1. Standard MessagePack spine binary (fixmap/fixarray with readable ASCII keys)
2. Custom binary format: 0x1c + 27-byte hash + Spine 3.8.99 binary data
   (with UTF-8 damage: ef bf bd sequences replacing non-UTF8 bytes)
"""

from __future__ import annotations

import sys
import json
import os
import struct
import logging
import traceback
from pathlib import Path
from typing import Any, Dict

try:
    import msgpack
except ImportError:
    msgpack = None

logger = logging.getLogger("spine_binary_to_spine")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


class ParseError(Exception):
    """Raised when parsing malformed or truncated .skel data."""
    pass


def safe_index(seq, index, context="array"):
    """Safely fetch item by index, raising ParseError if out of bounds."""
    if index < 0 or index >= len(seq):
        raise ParseError(f"{context} index out of bounds: {index} (size: {len(seq)})")
    return seq[index]


def _safe_count(v, limit=50000):
    return v if 0 <= v <= limit else 0


CUSTOM_HEADER_MAGIC = b'\x1c'
CUSTOM_VERSION = b'3.8.99'
_EFBFBD = b'\xef\xbf\xbd'  # UTF-8 U+FFFD replacement char


def is_spine_binary(data):
    """Detect standard MessagePack, custom binary, and Spine 4.x binary formats."""
    if not isinstance(data, bytes) or len(data) < 16:
        return False

    # Check for custom format: 0x1c + 27-byte hash + 0x07 + version
    if len(data) >= 36:
        if data[0] == 0x1c and data[28] == 0x07 and CUSTOM_VERSION in data[29:35]:
            return True

    # Check for Spine 4.x binary format: two int32 hashes + version string
    if len(data) >= 12 and data[0] == 0x00 and data[1] == 0x00 and data[2] == 0x00 and data[3] == 0x00:
        try:
            version = _read_string_at_offset(data, 8)
            if version and any(ch in version for ch in '0123456789.'):
                return True
        except Exception:
            pass

    # Standard MessagePack format (must contain spine key words in sample header)
    first = data[0]
    if (0x80 <= first <= 0x8F) or (0x90 <= first <= 0x9F) or first in (0xDE, 0xDF):
        sample = data[:512]
        if any(k in sample for k in (b"bones", b"slots", b"skeleton", b"skins", b"animations", b"events", b"ik")):
            return True
    return False


def _read_string_at_offset(data, offset):
    """Read a Spine modified-UTF8 string at a specific offset.

    Spine binary strings are prefixed with a varint byteCount (the count
    includes a trailing NUL byte, so a 0 length means the string is empty).
    Mirrors BinaryInput.readString semantics.
    """
    if offset >= len(data):
        return None
    # Decode varint byteCount.
    b = data[offset]
    byte_count = b & 0x7F
    shift = 7
    i = offset + 1
    while (b & 0x80) and i < len(data):
        b = data[i]
        byte_count |= (b & 0x7F) << shift
        shift += 7
        i += 1
    start = i
    if byte_count == 0:
        return None
    if byte_count == 1:
        return ""
    end = start + (byte_count - 1)
    if end > len(data):
        return None
    return data[start:end].decode("utf-8", errors="replace")


def decode_spine_4x_binary(data):
    """Decode Spine 4.x .skel binary format using the faithful skel2json converter."""
    from skel2json import SkeletonBinaryConverter
    conv = SkeletonBinaryConverter()
    result = conv.readSkeletonData(data)
    version = result.get("skeleton", {}).get("spine") or "4.x"
    _log_detected_version("spine_4x_binary", version)
    return result


def _detect_format(data):
    """Return 'custom', 'spine_4x_binary', or 'standard'."""
    if len(data) >= 36 and data[0] == 0x1c and data[28] == 0x07 and CUSTOM_VERSION in data[29:35]:
        return 'custom'
    if len(data) >= 12 and data[0] == 0x00 and data[1] == 0x00 and data[2] == 0x00 and data[3] == 0x00:
        try:
            version = _read_string_at_offset(data, 8)
            if version and any(ch in version for ch in '0123456789.'):
                return 'spine_4x_binary'
        except Exception:
            pass
    return 'standard'


def _log_detected_version(format_name, version):
    """Log the detected Spine binary format and version for debugging."""
    logger.info("Detected format: %s, version: %s", format_name, version)


def decode_standard(data):
    """Decode standard MessagePack format.

    Handles both single-object MessagePack and concatenated MessagePack
    streams (multiple MessagePack objects in one file).
    """
    if msgpack is None:
        raise RuntimeError("msgpack is required: pip install msgpack")

    # Try unpacking as raw bytes first to avoid UTF-8 decode errors
    try:
        return msgpack.unpackb(data, raw=False)
    except Exception:
        pass

    # Try incremental unpacking for concatenated MessagePack objects
    try:
        unpacker = msgpack.Unpacker(raw=True, strict_map_key=False)
        unpacker.feed(data)
        objects = []
        while True:
            try:
                obj = unpacker.unpack()
                objects.append(obj)
            except StopIteration:
                break

        # If we got exactly one object, return it
        if len(objects) == 1:
            return objects[0]

        # If we got multiple objects, look for one that looks like skeleton data
        # (has keys like 'skeleton', 'bones', 'slots', or 'animations')
        for obj in objects:
            if isinstance(obj, dict):
                keys = set()
                for k in obj.keys():
                    if isinstance(k, bytes):
                        keys.add(k.decode('utf-8', errors='replace'))
                    elif isinstance(k, str):
                        keys.add(k)
                if any(key in keys for key in ['skeleton', 'bones', 'slots', 'animations']):
                    return obj

        # Fallback: return the first dict-like object, or the first object
        for obj in objects:
            if isinstance(obj, dict):
                return obj
        return objects[0] if objects else {}

    except Exception:
        pass

    # Last resort: try standard unpacking (may fail on invalid UTF-8)
    try:
        return msgpack.unpackb(data, raw=False)
    except Exception:
        raise


def decode(data):
    """Decode spine binary data (auto-detect format)."""
    fmt = _detect_format(data)
    if fmt == 'custom':
        _log_detected_version('custom', '3.8.99')
        return decode_custom(data)
    if fmt == 'spine_4x_binary':
        version = _read_string_at_offset(data, 8) or "4.x"
        _log_detected_version('spine_4x_binary', version)
        return decode_spine_4x_binary(data)
    _log_detected_version('standard', 'messagepack')
    return decode_standard(data)


# ---------------------------------------------------------------------------
# Custom binary format decoder (Spine 3.8.99 with UTF-8 damage)
# ---------------------------------------------------------------------------

def _preprocess_custom(data):
    """Strip 28-byte custom header and fix UTF-8 damage.

    Each ef-bf-bd (U+FFFD replacement char, 3 bytes) in the raw file
    represents ONE unknown original byte → replace with 0x00.
    All other bytes are preserved as-is (including valid UTF-8 sequences
    that encode bytes 0x80-0xFF in string data).

    Prepends 8 zero-bytes as a fake hash header so the resulting buffer
    can be consumed by a standard Spine binary reader (readInt32 × 2 = hash).
    """
    out = bytearray()
    i = 28  # skip 0x1c + 27-byte ASCII hash
    n = len(data)
    while i < n:
        if data[i:i + 3] == _EFBFBD:
            out.append(0x00)
            i += 3
        else:
            out.append(data[i])
            i += 1
    # Fake 8-byte hash (zeroes) + version string + rest of skeleton data
    return b'\x00\x00\x00\x00\x00\x00\x00\x00' + bytes(out)


class _BI:
    """Minimal BinaryInput for preprocessed Spine 3.8.99 data."""

    def __init__(self, data):
        self.data = data
        self.n = len(data)
        self.index = 0
        self.strings = []  # string table populated after header

    def _check_bounds(self, needed):
        if self.index + needed > self.n:
            raise ParseError(f"Unexpected EOF: need {needed} bytes at offset {self.index}, have {self.n - self.index}")

    def _b(self):
        self._check_bounds(1)
        v = self.data[self.index]
        self.index += 1
        return v

    def readByte(self):
        v = self._b()
        return v if v < 128 else v - 256

    def readUnsignedByte(self):
        return self._b()

    def readShort(self):
        self._check_bounds(2)
        v = struct.unpack('>h', self.data[self.index:self.index + 2])[0]
        self.index += 2
        return v

    def readInt32(self):
        self._check_bounds(4)
        v = struct.unpack('>i', self.data[self.index:self.index + 4])[0]
        self.index += 4
        return v

    def readUint32(self):
        self._check_bounds(4)
        v = struct.unpack('>I', self.data[self.index:self.index + 4])[0]
        self.index += 4
        return v

    def readFloat(self):
        self._check_bounds(4)
        v = struct.unpack('>f', self.data[self.index:self.index + 4])[0]
        self.index += 4
        if v != v or abs(v) > 1e15:  # NaN / Inf from corrupted bytes
            return 0.0
        return v

    def readBoolean(self):
        return self._b() != 0

    def readInt(self, optimizePositive=True):
        b = self._b()
        result = b & 0x7F
        if b & 0x80:
            b = self._b(); result |= (b & 0x7F) << 7
            if b & 0x80:
                b = self._b(); result |= (b & 0x7F) << 14
                if b & 0x80:
                    b = self._b(); result |= (b & 0x7F) << 21
                    if b & 0x80:
                        b = self._b(); result |= (b & 0x7F) << 28
        return result if optimizePositive else (result >> 1) ^ -(result & 1)

    def readString(self):
        """Read Spine modified-UTF8 string (inline, not from string table)."""
        bc = self.readInt(True)
        if bc == 0:
            return None
        if bc == 1:
            return ""
        bc -= 1
        # Check if we have enough data
        if self.index + bc > self.n:
            raise ParseError(f"String length {bc} exceeds remaining data ({self.n - self.index} bytes)")
        chars = []
        i = 0
        while i < bc:
            b = self.readUnsignedByte()
            top = b >> 4
            if top in (12, 13):  # 2-byte modified UTF-8
                b2 = self.readUnsignedByte()
                chars.append(chr(((b & 0x1F) << 6) | (b2 & 0x3F)))
                i += 2
            elif top == 14:  # 3-byte modified UTF-8
                b2 = self.readUnsignedByte()
                b3 = self.readUnsignedByte()
                chars.append(chr(((b & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)))
                i += 3
            else:
                chars.append(chr(b))
                i += 1
        return ''.join(chars)

    def readStringRef(self):
        """Read string by index from the string table."""
        idx = self.readInt(True)
        if idx == 0:
            return None
        idx -= 1
        if idx < 0 or idx >= len(self.strings):
            return None
        return self.strings[idx]

    def readFloatArray(self, count, scale=1.0):
        count = _safe_count(count, 30000)
        # Check if we have enough data for count floats
        if self.index + count * 4 > self.n:
            raise ParseError(f"readFloatArray: need {count * 4} bytes for {count} floats, only {self.n - self.index} remaining")
        return [_f(self.readFloat() * scale) for _ in range(count)]

    def readShortArray(self):
        n = _safe_count(self.readInt(True), 30000)
        # Check if we have enough data for n shorts
        if self.index + n * 2 > self.n:
            raise ParseError(f"readShortArray: need {n * 2} bytes for {n} shorts, only {self.n - self.index} remaining")
        return [self.readShort() for _ in range(n)]


# Spine 3.8 constants
_TRANSFORM_MODES = ["Normal", "OnlyTranslation", "NoRotationOrReflection",
                    "NoScale", "NoScaleOrReflection"]
_BLEND_MODES = ["normal", "additive", "multiply", "screen"]
_POSITION_MODES = ["fixed", "percent"]
_SPACING_MODES = ["length", "fixed", "percent", "proportional"]
_ROTATE_MODES = ["tangent", "chain", "chainScale"]


def _f(v):
    if v is None:
        return None
    f = float(v)
    if f == int(f) and abs(f) < 1e15:
        return int(f)
    return round(f, 6)


def _rgba(c):
    c &= 0xFFFFFFFF
    return "%02x%02x%02x%02x" % ((c >> 24) & 0xFF, (c >> 16) & 0xFF,
                                  (c >> 8) & 0xFF, c & 0xFF)


def _rgb(c):
    c &= 0xFFFFFFFF
    return "%02x%02x%02x" % ((c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF)


class _Spine399Parser:
    """Full Spine 3.8.99 binary skeleton parser."""

    def parse(self, data):
        """Parse preprocessed (ef-bf-bd cleaned) binary data.

        data must start with 8 fake-hash bytes followed by the Spine 3.8
        skeleton binary stream (version string, x/y/w/h, ne, strings table, …).
        """
        inp = _BI(data)
        # Hash (fake 8 zero bytes)
        inp.readInt32()
        inp.readInt32()

        skel = {}
        version = inp.readString()
        skel["spine"] = version or "3.8.99"

        x = inp.readFloat()
        y = inp.readFloat()
        w = inp.readFloat()
        h = inp.readFloat()
        if x: skel["x"] = _f(x)
        if y: skel["y"] = _f(y)
        if w: skel["width"] = _f(w)
        if h: skel["height"] = _f(h)

        ne = inp.readBoolean()
        if ne:
            fps = inp.readFloat()
            if fps: skel["fps"] = _f(fps)
            img = inp.readString()
            if img: skel["images"] = img
            audio = inp.readString()
            if audio: skel["audio"] = audio

        # String table
        n_strings = _safe_count(inp.readInt(True))
        for _ in range(n_strings):
            s = inp.readString()
            inp.strings.append(s if s else "")

        # Bones
        bones = []
        bone_names_seen = set()
        n_bones = _safe_count(inp.readInt(True), 1000)
        for i in range(n_bones):
            raw_name = inp.readString() or f"bone{i}"
            # Sanitize: strip corruption artifacts (names joined with '!')
            name = raw_name.split('!')[0].strip()
            if not name:
                name = f"bone{i}"
            # Deduplicate bone names
            if name in bone_names_seen:
                name = f"{name}_{i}"
            bone_names_seen.add(name)
            parent = None
            if i > 0:
                pi = inp.readInt(True)
                # If parent index is corrupted/out-of-range, fall back to root bone
                if 0 <= pi < len(bones):
                    parent = safe_index(bones, pi, "bones")["name"]
                elif bones:
                    parent = bones[0]["name"]  # must have some parent — use root
            rot = inp.readFloat()
            bx = inp.readFloat()
            by = inp.readFloat()
            sx = inp.readFloat()
            sy = inp.readFloat()
            shx = inp.readFloat()
            shy = inp.readFloat()
            length = inp.readFloat()
            tm = inp.readInt(True)
            skin_req = inp.readBoolean()  # added in 3.8
            if ne:
                inp.readUint32()  # bone color

            bone = {"name": name}
            if parent:
                bone["parent"] = parent
            if rot: bone["rotation"] = _f(rot)
            if bx: bone["x"] = _f(bx)
            if by: bone["y"] = _f(by)
            if sx != 1 and sx != 0: bone["scaleX"] = _f(sx)
            if sy != 1 and sy != 0: bone["scaleY"] = _f(sy)
            if shx: bone["shearX"] = _f(shx)
            if shy: bone["shearY"] = _f(shy)
            if length: bone["length"] = _f(length)
            if tm and tm < len(_TRANSFORM_MODES):
                bone["transform"] = _TRANSFORM_MODES[tm]
            if skin_req:
                bone["skin"] = True
            bones.append(bone)

        # Slots — in 3.8.99 custom binary format: read count prefix first
        slots = []
        slot_names_seen = set()
        n_slots = _safe_count(inp.readInt(True), 10000)
        for _ in range(n_slots):
            name = inp.readString()
            if not name:
                break
            # Skip blank/corrupted slot names
            name = name.split('!')[0].strip()
            if not name:
                break
            # Deduplicate slot names
            if name in slot_names_seen:
                name = f"{name}_{len(slot_names_seen)}"
            slot_names_seen.add(name)
            bi = inp.readInt(True)
            if not (0 <= bi < len(bones)):
                bone_name = bones[0]["name"] if bones else "root"
            else:
                bone_name = safe_index(bones, bi, "bones")["name"]
            slot = {"name": name, "bone": bone_name}
            color = inp.readUint32()
            if color != 0xFFFFFFFF:
                slot["color"] = _rgba(color)
            dark = inp.readInt32()
            if dark != -1:
                slot["dark"] = _rgb(dark)
            att = inp.readStringRef()
            if att:
                slot["attachment"] = att
            blend = inp.readInt(True)
            if blend and blend < len(_BLEND_MODES):
                slot["blend"] = _BLEND_MODES[blend]
            slots.append(slot)

        # IK constraints
        ik_list = []
        ik_names_seen = set()
        n_ik = _safe_count(inp.readInt(True), 1000)
        for iki in range(n_ik):
            raw_name = inp.readString() or "ik"
            base_name = raw_name.split('!')[0].strip() or "ik"
            name = base_name
            suffix = 0
            while name in ik_names_seen:
                suffix += 1
                name = f"{base_name}_{suffix}"
            ik_names_seen.add(name)
            c = {"name": name}
            order = inp.readInt(True)
            nn = inp.readInt(True)
            idxs = [inp.readInt(True) for _ in range(nn)]
            c["bones"] = [safe_index(bones, idx, "bones")["name"] for idx in idxs]
            ti = inp.readInt(True)
            c["target"] = safe_index(bones, ti, "bones")["name"] if 0 <= ti < len(bones) else "root"
            mix = inp.readFloat()
            softness = inp.readFloat()
            bd = inp.readByte()
            compress = inp.readBoolean()
            stretch = inp.readBoolean()
            uniform = inp.readBoolean()
            if order: c["order"] = order
            if mix != 1: c["mix"] = _f(mix)
            if softness: c["softness"] = _f(softness)
            c["bendPositive"] = (bd == 1)
            if compress: c["compress"] = True
            if stretch: c["stretch"] = True
            if uniform: c["uniform"] = True
            ik_list.append(c)

        # Transform constraints
        tr_list = []
        tr_names_seen = set()
        n_tr = _safe_count(inp.readInt(True), 1000)
        for tri in range(n_tr):
            raw_name = inp.readString() or "tr"
            # Deduplicate names (corrupted data often produces many "tr")
            base_name = raw_name.split('!')[0].strip() or "tr"
            name = base_name
            suffix = 0
            while name in tr_names_seen:
                suffix += 1
                name = f"{base_name}_{suffix}"
            tr_names_seen.add(name)
            c = {"name": name}
            order = inp.readInt(True)
            nn = inp.readInt(True)
            idxs2 = [inp.readInt(True) for _ in range(nn)]
            c["bones"] = [safe_index(bones, idx, "bones")["name"] for idx in idxs2]
            ti = inp.readInt(True)
            c["source"] = safe_index(bones, ti, "bones")["name"] if 0 <= ti < len(bones) else (bones[0]["name"] if bones else "")
            inp.readBoolean()  # local
            inp.readBoolean()  # relative
            for fld in ["rotation", "x", "y", "scaleX", "scaleY", "shearY",
                        "mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"]:
                v = inp.readFloat()
                if v: c[fld] = _f(v)
            if order: c["order"] = order
            c["type"] = "transform"
            tr_list.append(c)

        # Path constraints — NOT present in 3.8.99 custom binary format
        path_list = []

        # Default skin
        skins = []
        default_skin = self._read_skin(inp, bones, slots, ne, default=True)
        if default_skin:
            skins.append(default_skin)

        # Named skins
        n_skins = _safe_count(inp.readInt(True), 1000)
        skin_names_seen = set()
        if default_skin:
            skin_names_seen.add(default_skin.get("name", "default"))
        for si in range(n_skins):
            skin = self._read_skin(inp, bones, slots, ne, default=False)
            if skin:
                sname = skin.get("name", "skin") or f"skin_{si}"
                base_sname = sname
                suffix = 0
                while sname in skin_names_seen:
                    suffix += 1
                    sname = f"{base_sname}_{suffix}"
                skin_names_seen.add(sname)
                skin["name"] = sname
                skins.append(skin)

        # Events
        events = {}
        n_events = _safe_count(inp.readInt(True), 10000)
        for _ in range(n_events):
            ev_name = inp.readStringRef() or "event"
            ev = {}
            iv = inp.readInt(False)
            fv = inp.readFloat()
            sv = inp.readString()
            audio = inp.readString()
            if iv: ev["int"] = iv
            if fv: ev["float"] = _f(fv)
            if sv: ev["string"] = sv
            if audio:
                ev["audio"] = audio
                ev["volume"] = _f(inp.readFloat())
                ev["balance"] = _f(inp.readFloat())
            events[ev_name] = ev

        # Animations
        animations = {}
        n_anims = _safe_count(inp.readInt(True), 10000)
        for _ in range(n_anims):
            anim_name = inp.readString() or "anim"
            animations[anim_name] = self._read_animation(inp, bones, slots, inp.strings)

        # Build output
        bone_set = {b["name"] for b in bones}
        output = {
            "skeleton": skel,
            "bones": bones,
            "slots": slots,
        }
        constraints = []
        for c in ik_list:
            e = dict(c); e["type"] = "ik"
            # Validate bones
            if all(b in bone_set for b in e.get("bones", [])) and e.get("target") in bone_set:
                constraints.append(e)
        for c in tr_list:
            # Validate source bone exists
            if c.get("source") in bone_set:
                constraints.append(c)
        for c in path_list:
            if c.get("slot") and all(b in bone_set for b in c.get("bones", [])):
                constraints.append(c)
        if constraints:
            output["constraints"] = constraints
        if skins:
            output["skins"] = skins
        if events:
            output["events"] = events
        if animations:
            output["animations"] = animations
        # Use 3.8.99 for Spine 3.8.99 CLI compatibility
        output["skeleton"]["spine"] = "3.8.99"
        return output

    # ------------------------------------------------------------------
    # Skin reading
    # ------------------------------------------------------------------

    def _read_skin(self, inp, bones, slots, ne, default):
        """Read a skin (default or named).
        In 3.8.99 custom binary:
        - Default skin: slot_count + per-slot: {slotIdx, n_att, per-att: {name_ref, type, data}}
        - Named skins: same structure prefixed with name_ref (no bone/ik/tr/path index arrays)
        """
        if default:
            slot_count = _safe_count(inp.readInt(True), 10000)
            if slot_count == 0:
                return None
            skin = {"name": "default"}
        else:
            name = inp.readStringRef() or "skin"
            skin = {"name": name}
            slot_count = _safe_count(inp.readInt(True), 10000)

        attachments = {}
        for _ in range(slot_count):
            si = inp.readInt(True)
            if si >= len(slots):
                # corrupted slot index — skip this skin slot's attachments
                n_att = _safe_count(inp.readInt(True), 10000)
                for _ in range(n_att):
                    inp.readStringRef()  # att name (discard)
                    self._skip_attachment(inp, ne)
                continue
            slot_name = safe_index(slots, si, "slots")["name"]
            n_att = _safe_count(inp.readInt(True), 10000)
            slot_atts = {}
            for _ in range(n_att):
                att_name = inp.readStringRef() or "att"
                att = self._read_attachment(inp, att_name, ne)
                if att is not None:
                    slot_atts[att_name] = att
            if slot_atts:
                attachments[slot_name] = slot_atts

        if attachments:
            skin["attachments"] = attachments
        return skin

    def _read_attachment(self, inp, att_name, ne):
        """Read attachment data. att_name was already read by caller.
        In 3.8.99: type byte, then type-specific data.
        Region: path(stringRef? or inline?), rot, x, y, sx, sy, w, h, color.
        In this custom format, path is NOT stored (use att_name as path).
        """
        t = inp.readByte()

        if t == 0:  # Region
            rot = inp.readFloat()
            x = inp.readFloat(); y = inp.readFloat()
            sx = inp.readFloat(); sy = inp.readFloat()
            w = inp.readFloat(); h = inp.readFloat()
            color = inp.readUint32()
            # In 3.8.99 custom binary: 2 extra bytes follow color (sequence flag + reserved)
            inp.readByte(); inp.readByte()
            att = {"type": "region", "path": att_name,
                   "width": _f(w), "height": _f(h)}
            if rot: att["rotation"] = _f(rot)
            if x: att["x"] = _f(x)
            if y: att["y"] = _f(y)
            if sx != 1: att["scaleX"] = _f(sx)
            if sy != 1: att["scaleY"] = _f(sy)
            if color != 0xFFFFFFFF: att["color"] = _rgba(color)
            return att

        elif t == 1:  # BoundingBox
            vc = inp.readInt(True)
            verts = self._read_vertices(inp, vc)
            color = inp.readUint32() if ne else 0
            att = {"type": "boundingbox", "vertexCount": vc}
            att.update(verts)
            return att

        elif t == 2:  # Mesh
            path = inp.readStringRef() or att_name
            color = inp.readUint32()
            vc = inp.readInt(True)
            uvs = inp.readFloatArray(vc * 2)
            tris = inp.readShortArray()
            verts = self._read_vertices(inp, vc)
            hull = inp.readInt(True)
            seq = self._read_sequence(inp)
            edges = []
            w = h = 0
            if ne:
                edges = inp.readShortArray()
                w = inp.readFloat(); h = inp.readFloat()
            att = {"type": "mesh", "path": path, "uvs": uvs,
                   "triangles": tris, "hull": hull}
            att.update(verts)
            if color != 0xFFFFFFFF: att["color"] = _rgba(color)
            if seq: att["sequence"] = seq
            if ne and edges: att["edges"] = edges
            if ne: att["width"] = _f(w); att["height"] = _f(h)
            return att

        elif t == 3:  # LinkedMesh
            path = inp.readStringRef() or att_name
            color = inp.readUint32()
            skin_name = inp.readStringRef()
            parent = inp.readStringRef()
            inherit = inp.readBoolean()
            seq = self._read_sequence(inp)
            w = h = 0
            if ne: w = inp.readFloat(); h = inp.readFloat()
            att = {"type": "linkedmesh", "path": path, "parent": parent}
            if color != 0xFFFFFFFF: att["color"] = _rgba(color)
            if skin_name: att["skin"] = skin_name
            if not inherit: att["timelines"] = False
            if seq: att["sequence"] = seq
            return att

        elif t == 4:  # Path
            closed = inp.readBoolean()
            const_speed = inp.readBoolean()
            vc = inp.readInt(True)
            verts = self._read_vertices(inp, vc)
            lengths = [_f(inp.readFloat()) for _ in range(vc // 3)]
            color = inp.readUint32() if ne else 0
            att = {"type": "path", "closed": closed,
                   "constantSpeed": const_speed, "vertexCount": vc,
                   "lengths": lengths}
            att.update(verts)
            return att

        elif t == 5:  # Point
            rot = inp.readFloat()
            x = inp.readFloat(); y = inp.readFloat()
            color = inp.readUint32() if ne else 0
            att = {"type": "point"}
            if x: att["x"] = _f(x)
            if y: att["y"] = _f(y)
            if rot: att["rotation"] = _f(rot)
            return att

        elif t == 6:  # Clipping
            end_si = inp.readInt(True)
            vc = inp.readInt(True)
            verts = self._read_vertices(inp, vc)
            color = inp.readUint32() if ne else 0
            att = {"type": "clipping", "vertexCount": vc}
            att.update(verts)
            return att

        return None

    def _skip_attachment(self, inp, ne):
        """Skip attachment bytes without storing, for corrupted/out-of-range slots."""
        t = inp.readByte()
        if t == 0:  # Region: 7 floats + color + 2 extra bytes
            for _ in range(7): inp.readFloat()
            inp.readUint32(); inp.readByte(); inp.readByte()
        elif t == 1:  # BoundingBox
            vc = inp.readInt(True); self._read_vertices(inp, vc)
            if ne: inp.readUint32()
        elif t == 2:  # Mesh
            inp.readStringRef(); inp.readUint32()
            vc = inp.readInt(True)
            inp.readFloatArray(vc * 2); inp.readShortArray()
            self._read_vertices(inp, vc); inp.readInt(True)
            self._read_sequence(inp)
            if ne: inp.readShortArray(); inp.readFloat(); inp.readFloat()
        elif t == 3:  # LinkedMesh
            inp.readStringRef(); inp.readUint32()
            inp.readStringRef(); inp.readStringRef(); inp.readBoolean()
            self._read_sequence(inp)
            if ne: inp.readFloat(); inp.readFloat()
        elif t == 4:  # Path
            inp.readBoolean(); inp.readBoolean()
            vc = inp.readInt(True); self._read_vertices(inp, vc)
            for _ in range(vc // 3): inp.readFloat()
            if ne: inp.readUint32()
        elif t == 5:  # Point
            inp.readFloat(); inp.readFloat(); inp.readFloat()
            if ne: inp.readUint32()
        elif t == 6:  # Clipping
            inp.readInt(True); vc = inp.readInt(True)
            self._read_vertices(inp, vc)
            if ne: inp.readUint32()
        # unknown types: nothing to skip safely

    def _read_sequence(self, inp):
        if not inp.readBoolean():
            return None
        count = inp.readInt(True)
        start = inp.readInt(True)
        digits = inp.readInt(True)
        setup = inp.readInt(True)
        seq = {"count": count}
        if start != 1: seq["start"] = start
        if digits: seq["digits"] = digits
        if setup: seq["setup"] = setup
        return seq

    def _read_vertices(self, inp, vc):
        # Protect against infinite loops from corrupted vertex counts
        vc = _safe_count(vc, 10000)
        vl = vc * 2
        if not inp.readBoolean():
            return {"vertices": inp.readFloatArray(vl)}
        weights = []
        bones_arr = []
        for _ in range(vc):
            bc = _safe_count(inp.readInt(True), 1000)
            bones_arr.append(bc)
            for _ in range(bc):
                bones_arr.append(inp.readInt(True))
                weights.append(_f(inp.readFloat()))
                weights.append(_f(inp.readFloat()))
                weights.append(_f(inp.readFloat()))
        combined = []
        bi = 0
        wi = 0
        n_weights = len(weights)
        while bi < len(bones_arr):
            bc = bones_arr[bi]; combined.append(bc); bi += 1
            for _ in range(bc):
                if bi >= len(bones_arr) or wi + 2 >= n_weights:
                    break
                combined.append(bones_arr[bi]); bi += 1
                combined.append(weights[wi]); wi += 1
                combined.append(weights[wi]); wi += 1
                combined.append(weights[wi]); wi += 1
        return {"vertices": combined}

    # ------------------------------------------------------------------
    # Animation reading (Spine 3.8 timeline format)
    # ------------------------------------------------------------------

    def _read_animation(self, inp, bones, slots, strings):
        anim = {}

        # Slot timelines — starts directly (no leading count prefix in 3.8.99)
        n = _safe_count(inp.readInt(True), len(slots))
        slot_timelines = {}
        for _ in range(n):
            si = inp.readInt(True)
            slot_name = safe_index(slots, si, "slots")["name"] if 0 <= si < len(slots) else f"slot{si}"
            nn = _safe_count(inp.readInt(True), 100)
            slot_map = slot_timelines.setdefault(slot_name, {})
            for _ in range(nn):
                tt = inp.readByte()
                fc = _safe_count(inp.readInt(True), 10000)
                if tt == 0:  # attachment
                    frames = []
                    for _ in range(fc):
                        frames.append({"time": _f(inp.readFloat()),
                                       "name": inp.readStringRef()})
                    slot_map["attachment"] = frames
                elif tt == 1:  # rgba
                    slot_map["rgba"] = self._read_rgba_timeline(inp, fc)
                elif tt == 2:  # rgb
                    slot_map["rgb"] = self._read_rgb_timeline(inp, fc)
                elif tt == 3:  # rgba2
                    slot_map["rgba2"] = self._read_rgba2_timeline(inp, fc)
                elif tt == 4:  # rgb2
                    slot_map["rgb2"] = self._read_rgb2_timeline(inp, fc)
                elif tt == 5:  # alpha
                    slot_map["alpha"] = self._read_curve_timeline1(inp, fc)
                else:
                    break  # unknown, can't continue safely
        if slot_timelines:
            anim["slots"] = slot_timelines

        # Bone timelines
        n = _safe_count(inp.readInt(True), len(bones))
        bone_timelines = {}
        for _ in range(n):
            bi = inp.readInt(True)
            if bi >= len(bones):
                break  # corrupted index — stop
            bone_name = safe_index(bones, bi, "bones")["name"]
            nn = _safe_count(inp.readInt(True), 100)
            bone_map = bone_timelines.setdefault(bone_name, {})
            for _ in range(nn):
                tt = inp.readByte()
                fc = _safe_count(inp.readInt(True), 10000)
                if tt == 0:    bone_map["rotate"] = self._read_curve_timeline1(inp, fc)
                elif tt == 1:  bone_map["translate"] = self._read_curve_timeline2(inp, fc)
                elif tt == 2:  bone_map["translateX"] = self._read_curve_timeline1(inp, fc)
                elif tt == 3:  bone_map["translateY"] = self._read_curve_timeline1(inp, fc)
                elif tt == 4:  bone_map["scale"] = self._read_curve_timeline2(inp, fc)
                elif tt == 5:  bone_map["scaleX"] = self._read_curve_timeline1(inp, fc)
                elif tt == 6:  bone_map["scaleY"] = self._read_curve_timeline1(inp, fc)
                elif tt == 7:  bone_map["shear"] = self._read_curve_timeline2(inp, fc)
                elif tt == 8:  bone_map["shearX"] = self._read_curve_timeline1(inp, fc)
                elif tt == 9:  bone_map["shearY"] = self._read_curve_timeline1(inp, fc)
                else:          break
        if bone_timelines:
            anim["bones"] = bone_timelines

        # IK timelines (skip safely)
        n = _safe_count(inp.readInt(True), 1000)
        for _ in range(n):
            inp.readInt(True)
            nn = _safe_count(inp.readInt(True), 100)
            for _ in range(nn):
                inp.readByte()
                fc = _safe_count(inp.readInt(True), 10000)
                self._skip_curve_timeline1(inp, fc)

        # Transform timelines
        n = _safe_count(inp.readInt(True), 1000)
        for _ in range(n):
            inp.readInt(True)
            nn = _safe_count(inp.readInt(True), 100)
            for _ in range(nn):
                inp.readByte()
                fc = _safe_count(inp.readInt(True), 10000)
                self._skip_curve_timeline_n(inp, fc, 4)

        # Path timelines (skip)
        n = _safe_count(inp.readInt(True), 1000)
        for _ in range(n):
            inp.readInt(True)
            nn = _safe_count(inp.readInt(True), 100)
            for _ in range(nn):
                inp.readByte()
                fc = _safe_count(inp.readInt(True), 10000)
                self._skip_curve_timeline1(inp, fc)

        # Deform timelines
        n = _safe_count(inp.readInt(True), 1000)
        deform_timelines = {}
        for _ in range(n):
            si = inp.readInt(True)  # skin index
            nn = _safe_count(inp.readInt(True), 1000)
            for _ in range(nn):
                slot_i = inp.readInt(True)
                nnn = _safe_count(inp.readInt(True), 1000)
                slot_name = safe_index(slots, slot_i, "slots")["name"] if 0 <= slot_i < len(slots) else f"slot{slot_i}"
                for _ in range(nnn):
                    att_name = inp.readStringRef() or "att"
                    fc = _safe_count(inp.readInt(True), 10000)
                    frames = []
                    for fi in range(fc):
                        time = inp.readFloat()
                        end = inp.readInt(True)
                        offset = inp.readInt(True)
                        verts_count = inp.readInt(True)
                        verts = [_f(inp.readFloat()) for _ in range(verts_count)]
                        frame = {"time": _f(time)}
                        if verts: frame["vertices"] = verts
                        if offset: frame["offset"] = offset
                        if fi < fc - 1:
                            curve = inp.readByte()
                            if curve == 1:
                                frame["curve"] = [_f(inp.readFloat()) for _ in range(4)]
                            elif curve == 2:
                                frame["curve"] = "stepped"
                        frames.append(frame)
                    key = f"{slot_name}/{att_name}"
                    deform_timelines.setdefault(slot_name, {})[att_name] = frames
        if deform_timelines:
            anim["deform"] = deform_timelines

        # Draw order timelines
        n = _safe_count(inp.readInt(True), 10000)
        if n:
            draw_order = []
            for _ in range(n):
                time = inp.readFloat()
                nn = _safe_count(inp.readInt(True), len(slots))
                offsets = []
                for _ in range(nn):
                    slot_idx = inp.readInt(True)
                    offset_val = inp.readInt(False)
                    s_name = safe_index(slots, slot_idx, "slots")["name"] if 0 <= slot_idx < len(slots) else "slot"
                    offsets.append({"slot": s_name, "offset": offset_val})
                draw_order.append({"time": _f(time), "offsets": offsets})
            anim["drawOrder"] = draw_order

        # Event timelines
        n = _safe_count(inp.readInt(True), 10000)
        if n:
            ev_frames = []
            for _ in range(n):
                time = inp.readFloat()
                ev_name = inp.readStringRef() or "event"
                iv = inp.readInt(False)
                fv = inp.readFloat()
                sv_flag = inp.readBoolean()
                sv = inp.readString() if sv_flag else None
                audio_flag = inp.readBoolean()
                if audio_flag:
                    inp.readFloat(); inp.readFloat()
                frame = {"time": _f(time), "name": ev_name}
                if iv: frame["int"] = iv
                if fv: frame["float"] = _f(fv)
                if sv: frame["string"] = sv
                ev_frames.append(frame)
            anim["events"] = ev_frames

        return anim

    # ------------------------------------------------------------------
    # Curve timeline helpers
    # ------------------------------------------------------------------

    def _read_curve(self, inp, frame_idx, frame_count, frames, keys):
        """Read curve data for a frame (appends 'curve' key if non-linear)."""
        if frame_idx >= frame_count - 1:
            return
        curve_type = inp.readByte()
        if curve_type == 1:   # stepped
            frames[frame_idx]["curve"] = "stepped"
        elif curve_type == 2:  # bezier
            frames[frame_idx]["curve"] = [_f(inp.readFloat()) for _ in range(4)]
        # 0 = linear, no extra data

    def _read_curve_timeline1(self, inp, fc):
        """Single-value curve timeline (rotate, scaleX, etc.)."""
        frames = []
        for i in range(fc):
            frame = {"time": _f(inp.readFloat()), "value": _f(inp.readFloat())}
            frames.append(frame)
            self._read_curve(inp, i, fc, frames, ["value"])
        return frames

    def _read_curve_timeline2(self, inp, fc):
        """Two-value curve timeline (translate, scale, shear)."""
        frames = []
        for i in range(fc):
            frame = {"time": _f(inp.readFloat()),
                     "x": _f(inp.readFloat()),
                     "y": _f(inp.readFloat())}
            frames.append(frame)
            self._read_curve(inp, i, fc, frames, ["x", "y"])
        return frames

    def _skip_curve_timeline1(self, inp, fc):
        for i in range(fc):
            inp.readFloat(); inp.readFloat()
            if i < fc - 1:
                ct = inp.readByte()
                if ct == 2:
                    for _ in range(4):
                        inp.readFloat()

    def _skip_curve_timeline_n(self, inp, fc, n_vals):
        for i in range(fc):
            inp.readFloat()
            for _ in range(n_vals): inp.readFloat()
            if i < fc - 1:
                ct = inp.readByte()
                if ct == 2:
                    for _ in range(4):
                        inp.readFloat()

    def _read_rgba_timeline(self, inp, fc):
        """In 3.8.99: no bezier_count prefix. Format: time(4)+r+g+b+a per frame."""
        frames = []
        time = inp.readFloat()
        r = inp.readUnsignedByte() / 255.0
        g = inp.readUnsignedByte() / 255.0
        b = inp.readUnsignedByte() / 255.0
        a = inp.readUnsignedByte() / 255.0
        for i in range(fc):
            color = "%02x%02x%02x%02x" % (int(r*255), int(g*255), int(b*255), int(a*255))
            frame = {"time": _f(time), "color": color}
            frames.append(frame)
            if i < fc - 1:
                time2 = inp.readFloat()
                r2 = inp.readUnsignedByte() / 255.0
                g2 = inp.readUnsignedByte() / 255.0
                b2 = inp.readUnsignedByte() / 255.0
                a2 = inp.readUnsignedByte() / 255.0
                ct = inp.readByte()
                if ct == 1:
                    frame["curve"] = "stepped"
                elif ct == 2:
                    frame["curve"] = [_f(inp.readFloat()) for _ in range(4)]
                time, r, g, b, a = time2, r2, g2, b2, a2
        return frames

    def _read_rgb_timeline(self, inp, fc):
        """In 3.8.99: no bezier_count prefix."""
        frames = []
        time = inp.readFloat()
        r = inp.readUnsignedByte() / 255.0
        g = inp.readUnsignedByte() / 255.0
        b = inp.readUnsignedByte() / 255.0
        for i in range(fc):
            color = "%02x%02x%02x" % (int(r*255), int(g*255), int(b*255))
            frame = {"time": _f(time), "color": color}
            frames.append(frame)
            if i < fc - 1:
                time2 = inp.readFloat()
                r2 = inp.readUnsignedByte() / 255.0
                g2 = inp.readUnsignedByte() / 255.0
                b2 = inp.readUnsignedByte() / 255.0
                ct = inp.readByte()
                if ct == 1:
                    frame["curve"] = "stepped"
                elif ct == 2:
                    frame["curve"] = [_f(inp.readFloat()) for _ in range(4)]
                time, r, g, b = time2, r2, g2, b2
        return frames

    def _read_rgba2_timeline(self, inp, fc):
        """In 3.8.99: no bezier_count prefix."""
        frames = []
        for i in range(fc):
            time = inp.readFloat()
            r = inp.readUnsignedByte() / 255.0; g = inp.readUnsignedByte() / 255.0
            b = inp.readUnsignedByte() / 255.0; a = inp.readUnsignedByte() / 255.0
            r2 = inp.readUnsignedByte() / 255.0; g2 = inp.readUnsignedByte() / 255.0
            b2 = inp.readUnsignedByte() / 255.0
            color = "%02x%02x%02x%02x" % (int(r*255), int(g*255), int(b*255), int(a*255))
            dark = "%02x%02x%02x" % (int(r2*255), int(g2*255), int(b2*255))
            frame = {"time": _f(time), "color": color, "dark": dark}
            frames.append(frame)
            if i < fc - 1:
                ct = inp.readByte()
                if ct == 1: frame["curve"] = "stepped"
                elif ct == 2: frame["curve"] = [_f(inp.readFloat()) for _ in range(4)]
        return frames

    def _read_rgb2_timeline(self, inp, fc):
        """In 3.8.99: no bezier_count prefix."""
        frames = []
        for i in range(fc):
            time = inp.readFloat()
            r = inp.readUnsignedByte() / 255.0; g = inp.readUnsignedByte() / 255.0
            b = inp.readUnsignedByte() / 255.0
            r2 = inp.readUnsignedByte() / 255.0; g2 = inp.readUnsignedByte() / 255.0
            b2 = inp.readUnsignedByte() / 255.0
            frame = {"time": _f(time),
                     "color": "%02x%02x%02x" % (int(r*255), int(g*255), int(b*255)),
                     "dark": "%02x%02x%02x" % (int(r2*255), int(g2*255), int(b2*255))}
            frames.append(frame)
            if i < fc - 1:
                ct = inp.readByte()
                if ct == 1: frame["curve"] = "stepped"
                elif ct == 2: frame["curve"] = [_f(inp.readFloat()) for _ in range(4)]
        return frames


def decode_custom(data):
    """Decode custom Spine 3.8.99 binary format into a Spine JSON dict."""
    if len(data) < 28:
        raise ParseError("custom header too short: %d bytes (need >= 28)" % len(data))
    hash_str = data[1:28].decode('ascii', errors='replace').rstrip('\x00')
    skel_data = _preprocess_custom(data)
    parser = _Spine399Parser()
    result = parser.parse(skel_data)
    if hash_str:
        result["skeleton"]["hash"] = hash_str
    return result


def convert_file(skel_path, json_path=None):
    """Convert a spine_binary.json (MessagePack or custom) to a standard Spine JSON file.

    Returns the output path.
    """
    skel_path = Path(skel_path)
    data = skel_path.read_bytes()
    try:
        skeleton = decode(data)
    except Exception:
        logger.error("Failed to decode %s, attempting legacy fallback", skel_path)
        traceback.print_exc()
        skeleton = _fallback_to_legacy(data)
    if json_path is None:
        json_path = os.path.splitext(str(skel_path))[0] + ".json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(skeleton, f, ensure_ascii=False, indent=2)
    return json_path


def _fallback_to_legacy(data: bytes) -> Dict[str, Any]:
    """Fall back to the legacy Spine 3.8.99 skeleton extractor on decode errors."""
    try:
        from extract_skeleton_3899 import extract_skeleton_3899
        result = extract_skeleton_3899(data)
        if isinstance(result, dict):
            logger.info("Legacy fallback succeeded for %d bytes", len(data))
            return result
    except Exception:
        logger.error("Legacy fallback also failed")
        traceback.print_exc()
    raise RuntimeError("Unable to decode spine binary data and legacy fallback failed")


def convert_to_spine(skel_path: Union[str, Path], spine_path: Union[str, Path], spine_exe: Union[str, Path]) -> str:
    """Convert a spine_binary.json directly to a .spine file via Spine CLI."""
    json_path = convert_file(skel_path)
    cmd = [spine_exe, "-i", json_path, "-o", spine_path, "-r"]
    import subprocess
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"spine compile timed out after 60s: {e}")
    if r.returncode != 0:
        raise RuntimeError(f"spine compile failed: {r.stderr.strip()[-200:]}")
    return spine_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python spine_binary_to_spine.py input.spine.json [output.json]",
              file=sys.stderr)
        raise SystemExit(1)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    out = convert_file(src, dst)
    print("Written:", out)