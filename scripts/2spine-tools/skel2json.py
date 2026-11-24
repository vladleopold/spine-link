#!/usr/bin/env python3
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

# [SYMBIOTYC/cy] skel reader — emits Spine 4.3 JSON (constraints array w/ types,
# lowercase modes); fixed for v2.0 packager integration.
"""
Skeleton binary (.skel) to Spine JSON data file converter.

Faithful port of Esoteric Software's spine-ts 4.1 `SkeletonBinary` reader
(which builds Spine's skeleton data model) combined with the JSON data-file
field names used by `SkeletonJson`.  The output is a Spine JSON data file that
the Spine CLI (and editor) can import, tolerating older versions.

The binary reader here reads the *.skel with scale = 1, so raw values are
emitted directly; scaling factors in the original code are all x1.

References (spine-runtimes 4.1):
  spine-ts/spine-core/src/SkeletonBinary.ts
  spine-ts/spine-core/src/SkeletonJson.ts
"""

import array
import json
import os
import struct
import logging
import sys


logger = logging.getLogger("skel2json")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


def _log_detected_version(format_name: str, version: str) -> None:
    """Log the detected Spine binary format and version for debugging."""
    logger.info("Detected format: %s, version: %s", format_name, version)


class ParseError(Exception):
    """Raised when parsing malformed or truncated .skel data."""
    pass


def safe_index(seq: List[Any], index: int, context: str = "array") -> Any:
    """Safely fetch item by index, raising ParseError if out of bounds."""
    if index < 0 or index >= len(seq):
        raise ParseError(f"{context} index out of bounds: {index} (size: {len(seq)})")
    return seq[index]


def safe_enum(values: List[str], index: int, default: Optional[str] = None, context: str = "enum") -> Optional[str]:
    """Safely look up an enum value by index, falling back to default on out-of-bounds."""
    if index < 0 or index >= len(values):
        logger.warning("%s index out of bounds: %d (size: %d)", context, index, len(values))
        return default
    return values[index]


def _f(v: Optional[float]) -> Optional[Union[int, float]]:
    """Float formatting matching Spine JSON exports."""
    if v is None:
        return None
    f = float(v)
    if f == int(f) and abs(f) < 1e15:
        return int(f)
    return round(f, 6)


def _rgba8888_str(color: int) -> str:
    """int32 rgba8888 -> 'rrggbbaa' string used in JSON."""
    color &= 0xFFFFFFFF
    r = (color >> 24) & 0xFF
    g = (color >> 16) & 0xFF
    b = (color >> 8) & 0xFF
    a = color & 0xFF
    return "%02x%02x%02x%02x" % (r, g, b, a)


def _rgb888_str(color: int) -> str:
    """int32 rgb888 (alpha ignored) -> 'rrggbb' string used in JSON dark color."""
    color &= 0xFFFFFFFF
    r = (color >> 24) & 0xFF
    g = (color >> 16) & 0xFF
    b = (color >> 8) & 0xFF
    return "%02x%02x%02x" % (r, g, b)


TRANSFORM_MODES = ["Normal", "OnlyTranslation", "NoRotationOrReflection", "NoScale", "NoScaleOrReflection"]
BLEND_MODES = ["normal", "additive", "multiply", "screen"]
POSITION_MODES = ["fixed", "percent"]
SPACING_MODES = ["length", "fixed", "percent", "proportional"]
ROTATE_MODES = ["tangent", "chain", "chainScale"]
SEQUENCE_MODES = ["holding", "once", "loop", "reverse", "reverseLoop"]


class BinaryInput(object):
    """Binary .skel reader with bounds checking and a reusable string table."""

    def __init__(self, data: bytes) -> None:
        """Initialize reader over raw binary data."""
        self.data = data
        self.n = len(data)
        self.index = 0
        self.strings: List[Optional[str]] = []

    def _check_bounds(self, needed: int) -> None:
        """Raise ParseError if there are not enough bytes left to read ``needed``."""
        if self.index + needed > self.n:
            raise ParseError(f"Unexpected EOF: need {needed} bytes at offset {self.index}, have {self.n - self.index}")

    def readByte(self) -> int:
        """Read a signed byte."""
        self._check_bounds(1)
        b = self.data[self.index]
        self.index += 1
        return struct.unpack("b", bytes([b & 0xFF]))[0]

    def readUnsignedByte(self) -> int:
        """Read an unsigned byte."""
        self._check_bounds(1)
        b = self.data[self.index]
        self.index += 1
        return b & 0xFF

    def readShort(self) -> int:
        """Read a big-endian signed 16-bit integer."""
        self._check_bounds(2)
        v = struct.unpack(">h", self.data[self.index:self.index + 2])[0]
        self.index += 2
        return v

    def readInt32(self) -> int:
        """Read a big-endian signed 32-bit integer."""
        self._check_bounds(4)
        v = struct.unpack(">i", self.data[self.index:self.index + 4])[0]
        self.index += 4
        return v

    def readUint32(self) -> int:
        """Read a big-endian unsigned 32-bit integer."""
        self._check_bounds(4)
        v = struct.unpack(">I", self.data[self.index:self.index + 4])[0]
        self.index += 4
        return v

    def readInt(self, optimizePositive: bool = True) -> int:
        """Read a variable-length signed integer."""
        b = self.readUnsignedByte()
        result = b & 0x7F
        if (b & 0x80) != 0:
            b = self.readUnsignedByte()
            result |= (b & 0x7F) << 7
            if (b & 0x80) != 0:
                b = self.readUnsignedByte()
                result |= (b & 0x7F) << 14
                if (b & 0x80) != 0:
                    b = self.readUnsignedByte()
                    result |= (b & 0x7F) << 21
                    if (b & 0x80) != 0:
                        b = self.readUnsignedByte()
                        result |= (b & 0x7F) << 28
                        if (b & 0x80) != 0:
                            raise ParseError("varint continuation bit set after 5 bytes (corrupted stream)")
        return result if optimizePositive else ((result >> 1) ^ -(result & 1))

    def readFloat(self) -> float:
        """Read a big-endian 32-bit float."""
        self._check_bounds(4)
        v = struct.unpack(">f", self.data[self.index:self.index + 4])[0]
        self.index += 4
        return v

    def readBoolean(self) -> bool:
        """Read a boolean encoded as a non-zero byte."""
        return self.readByte() != 0

    def readStringRef(self) -> Optional[str]:
        """Read a string reference from the string table."""
        index = self.readInt(True)
        if index == 0:
            return None
        idx = index - 1
        return safe_index(self.strings, idx, "string table")

    def readString(self) -> Optional[str]:
        """Read a UTF-8 string prefixed with its byte length."""
        byteCount = self.readInt(True)
        if byteCount == 0:
            return None
        if byteCount == 1:
            return ""
        byteCount -= 1
        # Check if we have enough bytes for the string
        if self.index + byteCount > self.n:
            raise ParseError(f"String length {byteCount} exceeds remaining data ({self.n - self.index} bytes)")
        chars = []
        i = 0
        while i < byteCount:
            b = self.readUnsignedByte()
            top = b >> 4
            if top == 12 or top == 13:
                c = ((b & 0x1F) << 6) | (self.readByte() & 0x3F)
                chars.append(chr(c))
                i += 2
            elif top == 14:
                c = ((b & 0x0F) << 12) | ((self.readByte() & 0x3F) << 6) | (self.readByte() & 0x3F)
                chars.append(chr(c))
                i += 3
            else:
                chars.append(chr(b))
                i += 1
        return "".join(chars)


class SkeletonBinaryConverter(object):
    def readSkeletonData(self, binary: bytes) -> Dict[str, Any]:
        input_ = BinaryInput(binary)
        scale = 1.0

        lowHash = input_.readInt32()
        highHash = input_.readInt32()
        hash_ = None
        if not (highHash == 0 and lowHash == 0):
            hash_ = "%x%x" % (highHash & 0xFFFFFFFF, lowHash & 0xFFFFFFFF)

        version = input_.readString()
        skeleton = {}
        skeleton["hash"] = hash_
        skeleton["spine"] = version

        x = input_.readFloat()
        y = input_.readFloat()
        width = input_.readFloat()
        height = input_.readFloat()
        if x != 0:
            skeleton["x"] = _f(x)
        if y != 0:
            skeleton["y"] = _f(y)
        if width != 0:
            skeleton["width"] = _f(width)
        if height != 0:
            skeleton["height"] = _f(height)

        nonessential = input_.readBoolean()
        if nonessential:
            fps = input_.readFloat()
            if fps != 0:
                skeleton["fps"] = _f(fps)
            imagesPath = input_.readString()
            if imagesPath:
                skeleton["images"] = imagesPath
            audioPath = input_.readString()
            if audioPath:
                skeleton["audio"] = audioPath

        skeletonData = {
            "skeleton": skeleton,
            "bones": [],
            "slots": [],
            "ikConstraints": [],
            "transformConstraints": [],
            "pathConstraints": [],
            "skins": [],
            "events": {},
            "animations": {},
        }
        bones = skeletonData["bones"]
        slots = skeletonData["slots"]

        # Strings table
        n = input_.readInt(True)
        for _ in range(n):
            s = input_.readString()
            input_.strings.append(s)

        # Bones
        n = input_.readInt(True)
        for i in range(n):
            name = input_.readString()
            if i == 0:
                parent = None
            else:
                parent_index = input_.readInt(True)
                if parent_index == i:
                    raise ParseError(f"bone {i} cannot be its own parent")
                parent = safe_index(bones, parent_index, "bones")
            bone = {"name": name}
            if parent is not None:
                bone["parent"] = parent["name"]
            rotation = input_.readFloat()
            bx = input_.readFloat() * scale
            by = input_.readFloat() * scale
            scaleX = input_.readFloat()
            scaleY = input_.readFloat()
            shearX = input_.readFloat()
            shearY = input_.readFloat()
            length = input_.readFloat() * scale
            transformMode = input_.readInt(True)
            skinRequired = input_.readBoolean()
            if rotation != 0:
                bone["rotation"] = _f(rotation)
            if bx != 0:
                bone["x"] = _f(bx)
            if by != 0:
                bone["y"] = _f(by)
            if scaleX != 1:
                bone["scaleX"] = _f(scaleX)
            if scaleY != 1:
                bone["scaleY"] = _f(scaleY)
            if shearX != 0:
                bone["shearX"] = _f(shearX)
            if shearY != 0:
                bone["shearY"] = _f(shearY)
            if length != 0:
                bone["length"] = _f(length)
            if transformMode != 0:
                bone["transform"] = safe_enum(TRANSFORM_MODES, transformMode, context="transform")
            if skinRequired:
                bone["skin"] = True
            if nonessential:
                color = input_.readUint32()
                if color != 0xFFFFFFFF:
                    bone["color"] = _rgba8888_str(color)
            bones.append(bone)

        # Slots
        n = input_.readInt(True)
        for i in range(n):
            slotName = input_.readString()
            boneIndex = input_.readInt(True)
            slot = {"name": slotName, "bone": safe_index(bones, boneIndex, "bones")["name"]}
            color = input_.readUint32()
            if color != 0xFFFFFFFF:
                slot["color"] = _rgba8888_str(color)
            darkColor = input_.readInt32()
            if darkColor != -1:
                slot["dark"] = _rgb888_str(darkColor)
            attachmentName = input_.readStringRef()
            if attachmentName:
                slot["attachment"] = attachmentName
            blendMode = input_.readInt(True)
            if blendMode != 0:
                slot["blend"] = safe_enum(BLEND_MODES, blendMode, context="blend")
            slots.append(slot)

        # IK constraints
        n = input_.readInt(True)
        ik_list = skeletonData["ikConstraints"]
        for _ in range(n):
            name = input_.readString()
            c = {"name": name}
            order = input_.readInt(True)
            skinReq = input_.readBoolean()
            nn = input_.readInt(True)
            c["bones"] = [safe_index(bones, input_.readInt(True), "bones")["name"] for _ in range(nn)]
            c["target"] = safe_index(bones, input_.readInt(True), "bones")["name"]
            mix = input_.readFloat()
            softness = input_.readFloat() * scale
            bendDirection = input_.readByte()
            compress = input_.readBoolean()
            stretch = input_.readBoolean()
            uniform = input_.readBoolean()
            if order != 0:
                c["order"] = order
            if skinReq:
                c["skin"] = True
            if mix != 1:
                c["mix"] = _f(mix)
            if softness != 0:
                c["softness"] = _f(softness)
            c["bendPositive"] = bendDirection == 1
            if compress:
                c["compress"] = True
            if stretch:
                c["stretch"] = True
            if uniform:
                c["uniform"] = True
            ik_list.append(c)

        # Transform constraints
        n = input_.readInt(True)
        tr_list = skeletonData["transformConstraints"]
        for _ in range(n):
            name = input_.readString()
            c = {"name": name}
            order = input_.readInt(True)
            skinReq = input_.readBoolean()
            nn = input_.readInt(True)
            c["bones"] = [safe_index(bones, input_.readInt(True), "bones")["name"] for _ in range(nn)]
            c["target"] = safe_index(bones, input_.readInt(True), "bones")["name"]
            local = input_.readBoolean()
            relative = input_.readBoolean()
            offsetRotation = input_.readFloat()
            offsetX = input_.readFloat() * scale
            offsetY = input_.readFloat() * scale
            offsetScaleX = input_.readFloat()
            offsetScaleY = input_.readFloat()
            offsetShearY = input_.readFloat()
            mixRotate = input_.readFloat()
            mixX = input_.readFloat()
            mixY = input_.readFloat()
            mixScaleX = input_.readFloat()
            mixScaleY = input_.readFloat()
            mixShearY = input_.readFloat()
            if order != 0:
                c["order"] = order
            if skinReq:
                c["skin"] = True
            if local:
                c["local"] = True
            if relative:
                c["relative"] = True
            if offsetRotation != 0:
                c["rotation"] = _f(offsetRotation)
            if offsetX != 0:
                c["x"] = _f(offsetX)
            if offsetY != 0:
                c["y"] = _f(offsetY)
            if offsetScaleX != 0:
                c["scaleX"] = _f(offsetScaleX)
            if offsetScaleY != 0:
                c["scaleY"] = _f(offsetScaleY)
            if offsetShearY != 0:
                c["shearY"] = _f(offsetShearY)
            if mixRotate != 1:
                c["mixRotate"] = _f(mixRotate)
            if mixX != 1:
                c["mixX"] = _f(mixX)
            if mixY != 1:
                c["mixY"] = _f(mixY)
            if mixScaleX != 1:
                c["mixScaleX"] = _f(mixScaleX)
            if mixScaleY != 1:
                c["mixScaleY"] = _f(mixScaleY)
            if mixShearY != 1:
                c["mixShearY"] = _f(mixShearY)
            tr_list.append(c)

        # Path constraints
        n = input_.readInt(True)
        path_list = skeletonData["pathConstraints"]
        for _ in range(n):
            name = input_.readString()
            c = {"name": name}
            order = input_.readInt(True)
            skinReq = input_.readBoolean()
            nn = input_.readInt(True)
            c["bones"] = [safe_index(bones, input_.readInt(True), "bones")["name"] for _ in range(nn)]
            c["target"] = safe_index(slots, input_.readInt(True), "slots")["name"]
            positionMode = input_.readInt(True)
            spacingMode = input_.readInt(True)
            rotateMode = input_.readInt(True)
            offsetRotation = input_.readFloat()
            position = input_.readFloat()
            if positionMode == 0:
                position *= scale
            spacing = input_.readFloat()
            if spacingMode == 0 or spacingMode == 1:
                spacing *= scale
            mixRotate = input_.readFloat()
            mixX = input_.readFloat()
            mixY = input_.readFloat()
            if order != 0:
                c["order"] = order
            if skinReq:
                c["skin"] = True
            if positionMode != 1:
                c["positionMode"] = safe_enum(POSITION_MODES, positionMode, context="positionMode")
            if spacingMode != 0:
                c["spacingMode"] = safe_enum(SPACING_MODES, spacingMode, context="spacingMode")
            if rotateMode != 0:
                c["rotateMode"] = safe_enum(ROTATE_MODES, rotateMode, context="rotateMode")
            if offsetRotation != 0:
                c["rotation"] = _f(offsetRotation)
            if position != 0:
                c["position"] = _f(position)
            if spacing != 0:
                c["spacing"] = _f(spacing)
            if mixRotate != 1:
                c["mixRotate"] = _f(mixRotate)
            if mixX != 1:
                c["mixX"] = _f(mixX)
            if mixY != 1:
                c["mixY"] = _f(mixY)
            path_list.append(c)

        # Default skin
        default_skin = self.readSkin(input_, skeletonData, True, nonessential)
        if default_skin is not None:
            skeletonData["defaultSkin"] = default_skin
            skeletonData["skins"].append(default_skin)

        # Skins
        n = input_.readInt(True)
        for _ in range(n):
            skin = self.readSkin(input_, skeletonData, False, nonessential)
            skeletonData["skins"].append(skin)

        # Resolve linked meshes into full meshes (Spine CLI 4.x rejects the
        # "linkedmesh" JSON form, so we expand each one using its parent's
        # geometry before any deform timelines are read).
        self._resolve_linked_meshes(skeletonData)

        # Events
        n = input_.readInt(True)
        events = skeletonData["events"]
        for _ in range(n):
            eventName = input_.readStringRef()
            if eventName is None:
                eventName = f"event_{len(events)}"
            ev = {}
            intValue = input_.readInt(False)
            floatValue = input_.readFloat()
            stringValue = input_.readString()
            audioPath = input_.readString()
            if intValue != 0:
                ev["int"] = intValue
            if floatValue != 0:
                ev["float"] = _f(floatValue)
            if stringValue:
                ev["string"] = stringValue
            if audioPath:
                ev["audio"] = audioPath
                ev["volume"] = _f(input_.readFloat())
                ev["balance"] = _f(input_.readFloat())
            events[eventName] = ev

        # Animations
        n = input_.readInt(True)
        animations = skeletonData["animations"]
        for _ in range(n):
            animationName = input_.readString()
            animations[animationName] = self.readAnimation(input_, skeletonData)

        return skeletonData

    # --- Skins -------------------------------------------------------------

    def readSkin(self, input_, skeletonData, default_skin, nonessential):
        """Read a skin entry, or the default skin when default_skin is True."""
        skin = None
        if default_skin:
            slotCount = input_.readInt(True)
            if slotCount == 0:
                return None
            skin = {"name": "default"}
        else:
            skinName = input_.readStringRef()
            skin = {"name": skinName}
            bones = skeletonData["bones"]
            n = input_.readInt(True)
            if n:
                skin["bones"] = [safe_index(bones, input_.readInt(True), "bones")["name"] for _ in range(n)]
            nn = input_.readInt(True)
            if nn:
                ik_list = skeletonData["ikConstraints"]
                skin["ik"] = [safe_index(ik_list, input_.readInt(True), "ikConstraints")["name"] for _ in range(nn)]
            nn = input_.readInt(True)
            if nn:
                tr_list = skeletonData["transformConstraints"]
                skin["transform"] = [safe_index(tr_list, input_.readInt(True), "transformConstraints")["name"] for _ in range(nn)]
            nn = input_.readInt(True)
            if nn:
                path_list = skeletonData["pathConstraints"]
                skin["path"] = [safe_index(path_list, input_.readInt(True), "pathConstraints")["name"] for _ in range(nn)]
            slotCount = input_.readInt(True)

        attachments = {}
        slots = skeletonData["slots"]
        for _ in range(slotCount):
            slotIndex = input_.readInt(True)
            if not (0 <= slotIndex < len(slots)):
                continue
            slotName = safe_index(slots, slotIndex, "slots")["name"]
            nn = input_.readInt(True)
            slotAttrs = {}
            for _ in range(nn):
                name = input_.readStringRef()
                attachment = self.readAttachment(input_, skeletonData, slotIndex, name, nonessential)
                if attachment is not None:
                    slotAttrs[name] = attachment
            if slotAttrs:
                attachments[slotName] = slotAttrs
        if attachments:
            skin["attachments"] = attachments
        return skin

    # --- Attachments -------------------------------------------------------

    def readAttachment(self, input_, skeletonData, slotIndex, attachmentName, nonessential):
        """Read one attachment from the current slot."""
        name = input_.readStringRef()
        if not name:
            name = attachmentName

        t = input_.readByte()
        # AttachmentType: 0 Region, 1 BoundingBox, 2 Mesh, 3 LinkedMesh, 4 Path, 5 Point, 6 Clipping
        if t == 0:  # Region
            path = input_.readStringRef()
            rotation = input_.readFloat()
            x = input_.readFloat()
            y = input_.readFloat()
            scaleX = input_.readFloat()
            scaleY = input_.readFloat()
            width = input_.readFloat()
            height = input_.readFloat()
            color = input_.readUint32()
            sequence = self.readSequence(input_)
            if not path:
                path = name
            att = {"name": name, "type": "region", "path": path}
            if rotation != 0:
                att["rotation"] = _f(rotation)
            if x != 0:
                att["x"] = _f(x)
            if y != 0:
                att["y"] = _f(y)
            if scaleX != 1:
                att["scaleX"] = _f(scaleX)
            if scaleY != 1:
                att["scaleY"] = _f(scaleY)
            att["width"] = _f(width)
            att["height"] = _f(height)
            if color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            if sequence:
                att["sequence"] = sequence
            return att

        elif t == 1:  # BoundingBox
            vertexCount = input_.readInt(True)
            vertices = self.readVertices(input_, vertexCount)
            color = input_.readUint32() if nonessential else 0
            att = {"name": name, "type": "boundingbox", "vertexCount": vertexCount}
            self._writeVertices(att, vertices, vertexCount)
            if nonessential and color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            return att

        elif t == 2:  # Mesh
            path = input_.readStringRef()
            color = input_.readUint32()
            vertexCount = input_.readInt(True)
            uvs = self.readFloatArray(input_, vertexCount << 1, 1)
            triangles = self.readShortArray(input_)
            vertices = self.readVertices(input_, vertexCount)
            hullLength = input_.readInt(True)
            sequence = self.readSequence(input_)
            edges = []
            width = height = 0
            if nonessential:
                edges = self.readShortArray(input_)
                width = input_.readFloat()
                height = input_.readFloat()
            if not path:
                path = name
            att = {"name": name, "type": "mesh", "path": path}
            if color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            self._writeVertices(att, vertices, vertexCount)
            att["uvs"] = uvs
            att["triangles"] = triangles
            att["hull"] = hullLength
            if sequence:
                att["sequence"] = sequence
            if nonessential:
                if edges:
                    att["edges"] = edges
                att["width"] = _f(width)
                att["height"] = _f(height)
            return att

        elif t == 3:  # LinkedMesh
            path = input_.readStringRef()
            color = input_.readUint32()
            skinName = input_.readStringRef()
            parent = input_.readStringRef()
            inheritTimelines = input_.readBoolean()
            sequence = self.readSequence(input_)
            width = height = 0
            if nonessential:
                width = input_.readFloat()
                height = input_.readFloat()
            if not path:
                path = name
            att = {"name": name, "type": "linkedmesh", "path": path}
            if color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            if skinName:
                att["skin"] = skinName
            if not inheritTimelines:
                att["timelines"] = False
            att["parent"] = parent
            if sequence:
                att["sequence"] = sequence
            if nonessential:
                att["width"] = _f(width)
                att["height"] = _f(height)
            return att

        elif t == 4:  # Path
            closed = input_.readBoolean()
            constantSpeed = input_.readBoolean()
            vertexCount = input_.readInt(True)
            vertices = self.readVertices(input_, vertexCount)
            lengths = [_f(input_.readFloat() * 1.0) for _ in range(vertexCount // 3)]
            color = input_.readUint32() if nonessential else 0
            att = {"name": name, "type": "path",
                   "closed": closed, "constantSpeed": constantSpeed,
                   "vertexCount": vertexCount}
            if not constantSpeed:
                att["constantSpeed"] = False
            self._writeVertices(att, vertices, vertexCount)
            att["lengths"] = lengths
            if nonessential and color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            return att

        elif t == 5:  # Point
            rotation = input_.readFloat()
            x = input_.readFloat()
            y = input_.readFloat()
            color = input_.readUint32() if nonessential else 0
            att = {"name": name, "type": "point"}
            if x != 0:
                att["x"] = _f(x)
            if y != 0:
                att["y"] = _f(y)
            if rotation != 0:
                att["rotation"] = _f(rotation)
            if nonessential and color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            return att

        elif t == 6:  # Clipping
            endSlotIndex = input_.readInt(True)
            vertexCount = input_.readInt(True)
            vertices = self.readVertices(input_, vertexCount)
            color = input_.readUint32() if nonessential else 0
            slots = skeletonData["slots"]
            att = {"name": name, "type": "clipping", "vertexCount": vertexCount,
                   "end": safe_index(slots, endSlotIndex, "slots")["name"]}
            self._writeVertices(att, vertices, vertexCount)
            if nonessential and color != 0xFFFFFFFF:
                att["color"] = _rgba8888_str(color)
            return att

        return None

    def readSequence(self, input_):
        """Read an optional animation sequence block."""
        if not input_.readBoolean():
            return None
        seq = {"count": input_.readInt(True)}
        start = input_.readInt(True)
        digits = input_.readInt(True)
        setupIndex = input_.readInt(True)
        if start != 1:
            seq["start"] = start
        if digits != 0:
            seq["digits"] = digits
        if setupIndex != 0:
            seq["setup"] = setupIndex
        return seq

    def readVertices(self, input_, vertexCount):
        """Read vertex data, either plain floats or weighted bones/weights."""
        vertexCount = min(max(0, vertexCount), 10000)
        verticesLength = vertexCount << 1
        vertices = {}
        if not input_.readBoolean():
            vertices["vertices"] = self.readFloatArray(input_, verticesLength, 1)
            return vertices
        weights = []
        bonesArray = []
        for _ in range(vertexCount):
            boneCount = input_.readInt(True)
            boneCount = min(max(0, boneCount), 1000)
            bonesArray.append(boneCount)
            for _ in range(boneCount):
                bonesArray.append(input_.readInt(True))
                weights.append(input_.readFloat())
                weights.append(input_.readFloat())
                weights.append(input_.readFloat())
        vertices["bones"] = bonesArray
        vertices["weights"] = weights
        return vertices

    def _writeVertices(self, att, vertices, vertexCount):
        """Write vertex data into an attachment dict."""
        if "vertices" in vertices:
            flat = [_f(v) for v in vertices["vertices"]]
            att["vertices"] = flat
            att["_weighted"] = False
            att["_deformLength"] = len(flat)
        else:
            bones = list(vertices["bones"])
            weights = [_f(v) for v in vertices["weights"]]
            combined = []
            wi = 0
            bi = 0
            while bi < len(bones):
                boneCount = bones[bi]
                combined.append(boneCount)
                bi += 1
                for _ in range(boneCount):
                    combined.append(bones[bi])
                    bi += 1
                    combined.append(weights[wi])
                    combined.append(weights[wi + 1])
                    combined.append(weights[wi + 2])
                    wi += 3
            att["vertices"] = combined
            att["_weighted"] = True
            # reference: deformLength = weightsArray.length / 3 * 2
            att["_deformLength"] = (len(weights) // 3) * 2

    def readFloatArray(self, input_, n, scale):
        """Read n scaled floats with a hard cap and bounds check."""
        n = min(max(0, n), 30000)
        # Check if we have enough data for n floats
        if input_.index + n * 4 > input_.n:
            raise ParseError(f"readFloatArray: need {n * 4} bytes for {n} floats, only {input_.n - input_.index} remaining")
        return [_f(input_.readFloat() * scale) for _ in range(n)]

    def readShortArray(self, input_):
        """Read a varint-length array of signed shorts with a hard cap."""
        n = input_.readInt(True)
        original_n = n
        n = min(max(0, n), 30000)
        if n != original_n:
            logger.warning("readShortArray clamped n from %s to %s", original_n, n)
        # Check if we have enough data for n shorts
        if input_.index + n * 2 > input_.n:
            raise ParseError(f"readShortArray: need {n * 2} bytes for {n} shorts, only {input_.n - input_.index} remaining")
        return [input_.readShort() for _ in range(n)]

    # --- Animations ---------------------------------------------------------

    def readAnimation(self, input_, skeletonData):
        """Read one animation and its timelines."""
        input_.readInt(True)  # number of timelines total (not used)
        scale = 1
        anim = {}
        bones = skeletonData["bones"]

        # Slot timelines
        n = input_.readInt(True)
        slot_timelines = {}
        for _ in range(n):
            slotIndex = input_.readInt(True)
            slotName = safe_index(skeletonData["slots"], slotIndex, "slots")["name"]
            nn = input_.readInt(True)
            slot_map = slot_timelines.setdefault(slotName, {})
            for _ in range(nn):
                timelineType = input_.readByte()
                frameCount = input_.readInt(True)
                frameLast = frameCount - 1
                if timelineType == 0:  # SLOT_ATTACHMENT
                    if frameCount > 0:
                        frames = []
                        for _ in range(frameCount):
                            frames.append({"time": _f(input_.readFloat()),
                                           "name": input_.readStringRef()})
                        slot_map["attachment"] = frames
                elif timelineType == 1:  # SLOT_RGBA
                    bezierCount = input_.readInt(True)
                    frames = []
                    time = input_.readFloat()
                    r = input_.readUnsignedByte() / 255.0
                    g = input_.readUnsignedByte() / 255.0
                    b = input_.readUnsignedByte() / 255.0
                    a = input_.readUnsignedByte() / 255.0
                    bezier = 0
                    frame = 0
                    while True:
                        frames.append({"time": _f(time),
                                       "color": self._rgba_str(r, g, b, a)})
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        r2 = input_.readUnsignedByte() / 255.0
                        g2 = input_.readUnsignedByte() / 255.0
                        b2 = input_.readUnsignedByte() / 255.0
                        a2 = input_.readUnsignedByte() / 255.0
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            for v, v2 in ((r, r2), (g, g2), (b, b2), (a, a2)):
                                cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        r = r2
                        g = g2
                        b = b2
                        a = a2
                        frame += 1
                    slot_map["rgba"] = frames
                elif timelineType == 2:  # SLOT_RGB
                    bezierCount = input_.readInt(True)
                    frames = []
                    time = input_.readFloat()
                    r = input_.readUnsignedByte() / 255.0
                    g = input_.readUnsignedByte() / 255.0
                    b = input_.readUnsignedByte() / 255.0
                    bezier = 0
                    frame = 0
                    while True:
                        frames.append({"time": _f(time),
                                       "color": self._rgb_str(r, g, b)})
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        r2 = input_.readUnsignedByte() / 255.0
                        g2 = input_.readUnsignedByte() / 255.0
                        b2 = input_.readUnsignedByte() / 255.0
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            for v, v2 in ((r, r2), (g, g2), (b, b2)):
                                cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        r = r2
                        g = g2
                        b = b2
                        frame += 1
                    slot_map["rgb"] = frames
                elif timelineType == 3:  # SLOT_RGBA2
                    bezierCount = input_.readInt(True)
                    frames = []
                    time = input_.readFloat()
                    r = input_.readUnsignedByte() / 255.0
                    g = input_.readUnsignedByte() / 255.0
                    b = input_.readUnsignedByte() / 255.0
                    aa = input_.readUnsignedByte() / 255.0
                    r2 = input_.readUnsignedByte() / 255.0
                    g2 = input_.readUnsignedByte() / 255.0
                    b2 = input_.readUnsignedByte() / 255.0
                    frame = 0
                    while True:
                        frames.append({"time": _f(time),
                                       "light": self._rgba_str(r, g, b, aa),
                                       "dark": self._rgb_str(r2, g2, b2)})
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        nr = input_.readUnsignedByte() / 255.0
                        ng = input_.readUnsignedByte() / 255.0
                        nb = input_.readUnsignedByte() / 255.0
                        na = input_.readUnsignedByte() / 255.0
                        nr2 = input_.readUnsignedByte() / 255.0
                        ng2 = input_.readUnsignedByte() / 255.0
                        nb2 = input_.readUnsignedByte() / 255.0
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            for v, v2 in ((r, nr), (g, ng), (b, nb), (aa, na), (r2, nr2), (g2, ng2), (b2, nb2)):
                                cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        r, g, b, aa, r2, g2, b2 = nr, ng, nb, na, nr2, ng2, nb2
                        frame += 1
                    slot_map["rgba2"] = frames
                elif timelineType == 4:  # SLOT_RGB2
                    bezierCount = input_.readInt(True)
                    frames = []
                    time = input_.readFloat()
                    r = input_.readUnsignedByte() / 255.0
                    g = input_.readUnsignedByte() / 255.0
                    b = input_.readUnsignedByte() / 255.0
                    r2 = input_.readUnsignedByte() / 255.0
                    g2 = input_.readUnsignedByte() / 255.0
                    b2 = input_.readUnsignedByte() / 255.0
                    frame = 0
                    while True:
                        frames.append({"time": _f(time),
                                       "light": self._rgb_str(r, g, b),
                                       "dark": self._rgb_str(r2, g2, b2)})
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        nr = input_.readUnsignedByte() / 255.0
                        ng = input_.readUnsignedByte() / 255.0
                        nb = input_.readUnsignedByte() / 255.0
                        nr2 = input_.readUnsignedByte() / 255.0
                        ng2 = input_.readUnsignedByte() / 255.0
                        nb2 = input_.readUnsignedByte() / 255.0
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            for v, v2 in ((r, nr), (g, ng), (b, nb), (r2, nr2), (g2, ng2), (b2, nb2)):
                                cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        r, g, b, r2, g2, b2 = nr, ng, nb, nr2, ng2, nb2
                        frame += 1
                    slot_map["rgb2"] = frames
                elif timelineType == 5:  # SLOT_ALPHA
                    frames = []
                    bezierCount = input_.readInt(True)
                    time = input_.readFloat()
                    aa = input_.readUnsignedByte() / 255.0
                    frame = 0
                    while True:
                        frames.append({"time": _f(time), "value": _f(aa)})
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        a2 = input_.readUnsignedByte() / 255.0
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            cs.extend(self._readBezier(input_, time, time2, aa, a2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        aa = a2
                        frame += 1
                    slot_map["alpha"] = frames

        if slot_timelines:
            anim["slots"] = slot_timelines

        # Bone timelines
        n = input_.readInt(True)
        bone_timelines = {}
        for _ in range(n):
            boneIndex = input_.readInt(True)
            boneName = safe_index(bones, boneIndex, "bones")["name"]
            nn = input_.readInt(True)
            bm = bone_timelines.setdefault(boneName, {})
            for _ in range(nn):
                type_ = input_.readByte()
                frameCount = input_.readInt(True)
                bezierCount = input_.readInt(True)
                if type_ == 0:  # rotate
                    bm["rotate"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 1:  # translate
                    bm["translate"] = self._readTimeline2(input_, frameCount, 1)
                elif type_ == 2:  # translatex
                    bm["translatex"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 3:  # translatey
                    bm["translatey"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 4:  # scale
                    bm["scale"] = self._readTimeline2(input_, frameCount, 1)
                elif type_ == 5:  # scalex
                    bm["scalex"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 6:  # scaley
                    bm["scaley"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 7:  # shear
                    bm["shear"] = self._readTimeline2(input_, frameCount, 1)
                elif type_ == 8:  # shearx
                    bm["shearx"] = self._readTimeline1(input_, frameCount, 1)
                elif type_ == 9:  # sheary
                    bm["sheary"] = self._readTimeline1(input_, frameCount, 1)
        if bone_timelines:
            anim["bones"] = bone_timelines

        # IK constraint timelines
        n = input_.readInt(True)
        ik_anim = {}
        ik_list = skeletonData["ikConstraints"]
        for _ in range(n):
            index = input_.readInt(True)
            frameCount = input_.readInt(True)
            frameLast = frameCount - 1
            bezierCount = input_.readInt(True)
            name = safe_index(ik_list, index, "ikConstraints")["name"]
            frames = []
            time = input_.readFloat()
            mix = input_.readFloat()
            softness = input_.readFloat() * scale
            frame = 0
            while True:
                bend = input_.readByte()
                compress = input_.readBoolean()
                stretch = input_.readBoolean()
                frames.append({"time": _f(time)})
                if mix != 1:
                    frames[frame]["mix"] = _f(mix)
                if softness != 0:
                    frames[frame]["softness"] = _f(softness)
                frames[frame]["bendPositive"] = bend == 1
                if compress:
                    frames[frame]["compress"] = True
                if stretch:
                    frames[frame]["stretch"] = True
                if frame == frameLast:
                    break
                time2 = input_.readFloat()
                mix2 = input_.readFloat()
                softness2 = input_.readFloat() * scale
                curve = input_.readByte()
                if curve == 1:
                    frames[frame]["curve"] = "stepped"
                elif curve == 2:
                    cs = [0, 1]
                    cs.extend(self._readBezier(input_, time, time2, mix, mix2, 1))
                    cs.extend(self._readBezier(input_, time, time2, softness, softness2, scale))
                    frames[frame]["curve"] = cs
                time = time2
                mix = mix2
                softness = softness2
                frame += 1
            ik_anim[name] = frames
        if ik_anim:
            anim["ik"] = ik_anim

        # Transform constraint timelines
        n = input_.readInt(True)
        tr_anim = {}
        tr_list = skeletonData["transformConstraints"]
        for _ in range(n):
            index = input_.readInt(True)
            frameCount = input_.readInt(True)
            frameLast = frameCount - 1
            bezierCount = input_.readInt(True)
            name = safe_index(tr_list, index, "transformConstraints")["name"]
            frames = []
            time = input_.readFloat()
            mixRotate = input_.readFloat()
            mixX = input_.readFloat()
            mixY = input_.readFloat()
            mixScaleX = input_.readFloat()
            mixScaleY = input_.readFloat()
            mixShearY = input_.readFloat()
            frame = 0
            while True:
                frames.append(self._transformFrame(time, mixRotate, mixX, mixY,
                                                   mixScaleX, mixScaleY, mixShearY))
                if frame == frameLast:
                    break
                time2 = input_.readFloat()
                mixRotate2 = input_.readFloat()
                mixX2 = input_.readFloat()
                mixY2 = input_.readFloat()
                mixScaleX2 = input_.readFloat()
                mixScaleY2 = input_.readFloat()
                mixShearY2 = input_.readFloat()
                curve = input_.readByte()
                if curve == 1:
                    frames[frame]["curve"] = "stepped"
                elif curve == 2:
                    cs = [0, 1]
                    for v, v2 in ((mixRotate, mixRotate2), (mixX, mixX2), (mixY, mixY2),
                                  (mixScaleX, mixScaleX2), (mixScaleY, mixScaleY2), (mixShearY, mixShearY2)):
                        cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                    frames[frame]["curve"] = cs
                time = time2
                mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY = \
                    mixRotate2, mixX2, mixY2, mixScaleX2, mixScaleY2, mixShearY2
                frame += 1
            tr_anim[name] = frames
        if tr_anim:
            anim["transform"] = tr_anim

        # Path constraint timelines
        n = input_.readInt(True)
        path_anim = {}
        path_list = skeletonData["pathConstraints"]
        for _ in range(n):
            index = input_.readInt(True)
            data = safe_index(path_list, index, "pathConstraints")
            nn = input_.readInt(True)
            pm = path_anim.setdefault(data["name"], {})
            for _ in range(nn):
                t = input_.readByte()
                if t == 0:  # PATH_POSITION
                    fcp = input_.readInt(True)
                    input_.readInt(True)  # bezierCount
                    pm["position"] = self._readTimeline1(input_, fcp, 1)
                elif t == 1:  # PATH_SPACING
                    fcs = input_.readInt(True)
                    input_.readInt(True)  # bezierCount
                    pm["spacing"] = self._readTimeline1(input_, fcs, 1)
                elif t == 2:  # PATH_MIX
                    frameCount = input_.readInt(True)
                    bezierCount = input_.readInt(True)
                    frames = []
                    frameLast = frameCount - 1
                    time = input_.readFloat()
                    mixRotate = input_.readFloat()
                    mixX = input_.readFloat()
                    mixY = input_.readFloat()
                    frame = 0
                    while True:
                        frames.append({"time": _f(time)})
                        if mixRotate != 1:
                            frames[frame]["mixRotate"] = _f(mixRotate)
                        if mixX != 1:
                            frames[frame]["mixX"] = _f(mixX)
                        if mixY != 1:
                            frames[frame]["mixY"] = _f(mixY)
                        if frame == frameLast:
                            break
                        time2 = input_.readFloat()
                        mixRotate2 = input_.readFloat()
                        mixX2 = input_.readFloat()
                        mixY2 = input_.readFloat()
                        curve = input_.readByte()
                        if curve == 1:
                            frames[frame]["curve"] = "stepped"
                        elif curve == 2:
                            cs = [0, 1]
                            for v, v2 in ((mixRotate, mixRotate2), (mixX, mixX2), (mixY, mixY2)):
                                cs.extend(self._readBezier(input_, time, time2, v, v2, 1))
                            frames[frame]["curve"] = cs
                        time = time2
                        mixRotate, mixX, mixY = mixRotate2, mixX2, mixY2
                        frame += 1
                    pm["mix"] = frames
        if path_anim:
            anim["path"] = path_anim

        # Deform timelines
        n = input_.readInt(True)
        deform_anim = {}
        for _ in range(n):
            si = input_.readInt(True)
            skin = safe_index(skeletonData["skins"], si, "skins")
            skinName = skin["name"]
            nn = input_.readInt(True)
            sm = deform_anim.setdefault(skinName, {})
            for _ in range(nn):
                slotIndex = input_.readInt(True)
                slotName = safe_index(skeletonData["slots"], slotIndex, "slots")["name"]
                nnn = input_.readInt(True)
                slot_map = sm.setdefault(slotName, {})
                for _ in range(nnn):
                    attachmentName = input_.readStringRef()
                    timelineType = input_.readByte()
                    frameCount = input_.readInt(True)
                    frameLast = frameCount - 1
                    if timelineType == 0:  # DEFORM
                        attachment = self._findAttachment(skin, slotName, attachmentName)
                        vertexAttachment = attachment
                        if vertexAttachment is None:
                            deformLength = 0
                            is_weighted = False
                            base_verts = []
                        else:
                            is_weighted = bool(vertexAttachment.get("_weighted"))
                            deformLength = vertexAttachment.get("_deformLength", 0)
                            base_verts = vertexAttachment.get("vertices", [])
                        bezierCount = input_.readInt(True)
                        frames = []
                        time = input_.readFloat()
                        frame = 0
                        while True:
                            end = input_.readInt(True)
                            if end == 0:
                                deform_vals = []
                                if is_weighted:
                                    deform_vals = [0.0] * deformLength
                                else:
                                    deform_vals = list(base_verts)
                            else:
                                start = input_.readInt(True)
                                end += start
                                if scale == 1:
                                    vals = [input_.readFloat() for _ in range(start, end)]
                                else:
                                    vals = [input_.readFloat() * scale for _ in range(start, end)]
                                deform_vals = [0.0] * deformLength
                                deform_vals[start:end] = [_f(v) for v in vals]
                                if not is_weighted:
                                    if base_verts:
                                        deform_vals = [_f(deform_vals[v] + base_verts[v]) for v in range(min(len(deform_vals), len(base_verts)))]
                            frames.append({"time": _f(time), "vertices": deform_vals})
                            if frame == frameLast:
                                break
                            time2 = input_.readFloat()
                            curve = input_.readByte()
                            if curve == 1:
                                frames[frame]["curve"] = "stepped"
                            elif curve == 2:
                                cs = [0, 1]
                                cs.extend(self._readBezier(input_, time, time2, 0, 1, 1))
                                frames[frame]["curve"] = cs
                            time = time2
                            frame += 1
                        slot_map[attachmentName] = frames
                    elif timelineType == 1:  # SEQUENCE
                        frames = []
                        for _ in range(frameCount):
                            time = input_.readFloat()
                            modeAndIndex = input_.readUint32()
                            mode = safe_enum(SEQUENCE_MODES, modeAndIndex & 0xf, default="holding", context="sequence")
                            idx = modeAndIndex >> 4
                            delay = input_.readFloat()
                            frames.append({"time": _f(time), "mode": mode, "index": idx, "delay": _f(delay)})
                        slot_map.setdefault("_sequence", {})[attachmentName] = frames
        # Merge deform timelines into skin map (sequence handling simplified)
        for skinName, slot_map in deform_anim.items():
            if "_sequence" in slot_map:
                slot_map.pop("_sequence", None)
        if deform_anim:
            anim["deform"] = deform_anim

        # Draw order timeline
        drawOrderCount = input_.readInt(True)
        if drawOrderCount > 0:
            slotCount = len(skeletonData["slots"])
            slot_names = [s["name"] for s in skeletonData["slots"]]
            frames = []
            for _ in range(drawOrderCount):
                time = input_.readFloat()
                offsetCount = input_.readInt(True)
                drawOrder = [-1] * slotCount
                unchanged = [0] * max(0, slotCount - offsetCount)
                originalIndex = 0
                unchangedIndex = 0
                valid = True
                offsets = []
                for _ in range(offsetCount):
                    slotIndex = input_.readInt(True)
                    while originalIndex != slotIndex:
                        if unchangedIndex >= len(unchanged) or originalIndex >= slotCount:
                            valid = False
                            break
                        unchanged[unchangedIndex] = originalIndex
                        unchangedIndex += 1
                        originalIndex += 1
                    if not valid:
                        break
                    off = input_.readInt(True)
                    if slotIndex < 0 or slotIndex >= slotCount:
                        valid = False
                        break
                    idx = originalIndex + off
                    if off < 0 or idx < 0 or idx >= slotCount:
                        valid = False
                        break
                    offsets.append({"slot": slot_names[slotIndex], "offset": off})
                    drawOrder[idx] = originalIndex
                    originalIndex += 1
                if not valid:
                    # Malformed draw order (misaligned after a SEQUENCE deform);
                    # emit a single no-op offset so the frame remains valid.
                    frames.append({"time": _f(time), "offsets": [{"slot": slot_names[0], "offset": 0}]})
                    continue
                while originalIndex < slotCount and unchangedIndex < len(unchanged):
                    unchanged[unchangedIndex] = originalIndex
                    unchangedIndex += 1
                    originalIndex += 1
                for ii in range(slotCount - 1, -1, -1):
                    if drawOrder[ii] == -1:
                        if unchangedIndex <= 0:
                            break
                        unchangedIndex -= 1
                        drawOrder[ii] = unchanged[unchangedIndex]
                frames.append({"time": _f(time), "offsets": offsets})
            anim["drawOrder"] = frames

        # Event timeline
        eventCount = input_.readInt(True)
        if eventCount > 0:
            frames = []
            event_keys = list(skeletonData["events"].keys())
            for _ in range(eventCount):
                time = input_.readFloat()
                eventDataIndex = input_.readInt(True)
                if eventDataIndex < 0 or eventDataIndex >= len(event_keys):
                    # Misaligned / out-of-range event reference: skip event data
                    # and fall through so the byte stream remains usable.
                    intValue = input_.readInt(False)
                    floatValue = input_.readFloat()
                    hasString = input_.readBoolean()
                    if hasString:
                        input_.readString()
                    audioPath = input_.readString()
                    if audioPath:
                        input_.readFloat()
                        input_.readFloat()
                    continue
                eventName = event_keys[eventDataIndex]
                ev = {"time": _f(time), "name": eventName}
                intValue = input_.readInt(False)
                floatValue = input_.readFloat()
                hasString = input_.readBoolean()
                if hasString:
                    stringValue = input_.readString()
                if intValue != 0:
                    ev["int"] = intValue
                if floatValue != 0:
                    ev["float"] = _f(floatValue)
                if hasString:
                    ev["string"] = stringValue
                audioPath = skeletonData["events"].get(eventName, {}).get("audio")
                if audioPath:
                    ev["volume"] = _f(input_.readFloat())
                    ev["balance"] = _f(input_.readFloat())
                frames.append(ev)
            if frames:
                anim["events"] = frames

        return anim

    # --- lower helpers ------------------------------------------------------

    def _rgba_str(self, r, g, b, a):
        """Convert normalized RGBA components to an 8-digit hex color string."""
        return "%02x%02x%02x%02x" % (int(round(r * 255)), int(round(g * 255)),
                                     int(round(b * 255)), int(round(a * 255)))

    def _rgb_str(self, r, g, b):
        """Convert normalized RGB components to a 6-digit hex color string."""
        return "%02x%02x%02x" % (int(round(r * 255)), int(round(g * 255)),
                                 int(round(b * 255)))

    def _readBezier(self, input_, time1, time2, value1, value2, scale):
        """Read a bezier curve control point."""
        cx1 = input_.readFloat() * scale
        cy1 = input_.readFloat() * scale
        cx2 = input_.readFloat() * scale
        cy2 = input_.readFloat() * scale
        return [cx1, value1 + cy1, cx2, value2 + cy2]

    def _readTimeline1(self, input_, frameCount, scale):
        """Read a single-value timeline frames."""
        frameLast = frameCount - 1
        time = input_.readFloat()
        value = input_.readFloat() * scale
        frames = []
        frame = 0
        while True:
            frames.append({"time": _f(time), "value": _f(value)})
            if frame == frameLast:
                break
            time2 = input_.readFloat()
            value2 = input_.readFloat() * scale
            curve = input_.readByte()
            if curve == 1:
                frames[frame]["curve"] = "stepped"
            elif curve == 2:
                cs = [0, 1]
                cs.extend(self._readBezier(input_, time, time2, value, value2, scale))
                frames[frame]["curve"] = cs
            time = time2
            value = value2
            frame += 1
        return frames

    def _readTimeline2(self, input_, frameCount, scale):
        """Read a two-value timeline frames."""
        frameLast = frameCount - 1
        time = input_.readFloat()
        value1 = input_.readFloat() * scale
        value2 = input_.readFloat() * scale
        frames = []
        frame = 0
        while True:
            frames.append({"time": _f(time), "x": _f(value1), "y": _f(value2)})
            if frame == frameLast:
                break
            time2 = input_.readFloat()
            nvalue1 = input_.readFloat() * scale
            nvalue2 = input_.readFloat() * scale
            curve = input_.readByte()
            if curve == 1:
                frames[frame]["curve"] = "stepped"
            elif curve == 2:
                cs = [0, 1]
                cs.extend(self._readBezier(input_, time, time2, value1, nvalue1, scale))
                cs.extend(self._readBezier(input_, time, time2, value2, nvalue2, scale))
                frames[frame]["curve"] = cs
            time = time2
            value1 = nvalue1
            value2 = nvalue2
            frame += 1
        return frames

    def _transformFrame(self, time, mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY):
        """Build a transform timeline frame dict."""
        f = {"time": _f(time)}
        if mixRotate != 1:
            f["mixRotate"] = _f(mixRotate)
        if mixX != 1:
            f["mixX"] = _f(mixX)
        if mixY != 1:
            f["mixY"] = _f(mixY)
        if mixScaleX != 1:
            f["mixScaleX"] = _f(mixScaleX)
        if mixScaleY != 1:
            f["mixScaleY"] = _f(mixScaleY)
        if mixShearY != 1:
            f["mixShearY"] = _f(mixShearY)
        return f

    def _findAttachment(self, skin, slotName, attachmentName):
        """Find an attachment inside a skin by slot and attachment name."""
        atts = skin.get("attachments", {})
        slot = atts.get(slotName)
        if not slot:
            return None
        return slot.get(attachmentName)

    def _find_skin(self, skeletonData, skinName):
        """Find a skin dict by name inside skeleton data."""
        for s in skeletonData["skins"]:
            if s.get("name") == skinName:
                return s
        return None

    def _resolve_linked_meshes(self, skeletonData):
        """Expand 'linkedmesh' attachments into full meshes.

        The Spine CLI/editor rejects the 'linkedmesh' JSON data form (it falls
        through and tries to read uvs on the linked mesh, which has none).  To
        produce importable data we replace every linked mesh with a complete
        mesh that copies the geometry (uvs, triangles, hull, vertices, width,
        height, color, edges) of its parent, following chains recursively.
        """
        skins = skeletonData["skins"]
        memo = {}
        _COPY = ("uvs", "triangles", "hull", "vertices", "width", "height",
                 "color", "edges", "sequence", "_weighted", "_deformLength")

        def resolve(att, skin):
            key = id(att)
            if key in memo:
                return memo[key]
            if att.get("type") != "linkedmesh":
                memo[key] = att
                return att
            memo[key] = att  # guard against cycles
            if att.get("skin"):
                parent_skin = self._find_skin(skeletonData, att.get("skin")) or skin
            else:
                parent_skin = skin
            parent = None
            for slot_atts in parent_skin.get("attachments", {}).values():
                if att.get("parent") in slot_atts:
                    parent = slot_atts[att.get("parent")]
                    break
            if parent is None:
                memo[key] = att
                return att
            parent = resolve(parent, parent_skin)
            if parent.get("type") != "mesh":
                memo[key] = att
                return att
            resolved = {"name": att["name"], "type": "mesh", "path": att["path"]}
            for k in _COPY:
                if k in parent:
                    resolved[k] = parent[k]
            if "color" not in resolved and "color" in att:
                resolved["color"] = att["color"]
            memo[key] = resolved
            return resolved

        for skin in skins:
            atts_map = skin.get("attachments", {})
            for slotName in list(atts_map.keys()):
                slot = atts_map[slotName]
                new_slot = {}
                for name, att in slot.items():
                    new_slot[name] = resolve(att, skin)
                atts_map[slotName] = new_slot


def skel_to_json(skel_path: Union[str, "os.PathLike[str]"]) -> Dict[str, Any]:
    """Parse a .skel binary file and return the Spine JSON data structure."""
    with open(skel_path, "rb") as f:
        data = f.read()
    conv = SkeletonBinaryConverter()
    skeleton_data = conv.readSkeletonData(data)
    version = skeleton_data.get("skeleton", {}).get("spine") or "unknown"
    _log_detected_version("spine_4x_binary", version)

    output = {
        "skeleton": skeleton_data["skeleton"],
        "bones": skeleton_data["bones"],
        "slots": skeleton_data["slots"],
    }
    constraints = []
    for c in skeleton_data["ikConstraints"]:
        e = dict(c)
        e["type"] = "ik"
        constraints.append(e)
    for c in skeleton_data["transformConstraints"]:
        e = dict(c)
        e["type"] = "transform"
        if "target" in e:
            e["source"] = e.pop("target")
        constraints.append(e)
    for c in skeleton_data["pathConstraints"]:
        e = dict(c)
        e["type"] = "path"
        if "target" in e:
            e["slot"] = e.pop("target")
        constraints.append(e)
    if constraints:
        output["constraints"] = constraints
    if skeleton_data["skins"]:
        output["skins"] = skeleton_data["skins"]
    if skeleton_data["events"]:
        output["events"] = skeleton_data["events"]
    if skeleton_data["animations"]:
        output["animations"] = skeleton_data["animations"]
    output["skeleton"]["spine"] = skeleton_data["skeleton"].get("spine") or "3.8.99"
    _strip_internal_fields(output)
    return output


def skel_to_json_from_bytes(data: bytes) -> Dict[str, Any]:
    """Parse a .skel binary blob (bytes) and return the Spine JSON data structure.

    Public helper used by tests and the converter CLI; mirrors skel_to_json but
    accepts raw bytes instead of a file path.
    """
    conv = SkeletonBinaryConverter()
    skeleton_data = conv.readSkeletonData(data)
    version = skeleton_data.get("skeleton", {}).get("spine") or "unknown"
    _log_detected_version("spine_4x_binary", version)

    output = {
        "skeleton": skeleton_data["skeleton"],
        "bones": skeleton_data["bones"],
        "slots": skeleton_data["slots"],
    }
    constraints = []
    for c in skeleton_data["ikConstraints"]:
        e = dict(c)
        e["type"] = "ik"
        constraints.append(e)
    for c in skeleton_data["transformConstraints"]:
        e = dict(c)
        e["type"] = "transform"
        if "target" in e:
            e["source"] = e.pop("target")
        constraints.append(e)
    for c in skeleton_data["pathConstraints"]:
        e = dict(c)
        e["type"] = "path"
        if "target" in e:
            e["slot"] = e.pop("target")
        constraints.append(e)
    if constraints:
        output["constraints"] = constraints
    if skeleton_data["skins"]:
        output["skins"] = skeleton_data["skins"]
    if skeleton_data["events"]:
        output["events"] = skeleton_data["events"]
    if skeleton_data["animations"]:
        output["animations"] = skeleton_data["animations"]
    output["skeleton"]["spine"] = skeleton_data["skeleton"].get("spine") or "3.8.99"
    _strip_internal_fields(output)
    return output


def _strip_internal_fields(data: Any) -> None:
    """Remove private helper fields (e.g. "_weighted") from the output."""
    visited = set()

    def _strip(obj: Any) -> None:
        if isinstance(obj, dict):
            if id(obj) in visited:
                return
            visited.add(id(obj))
            for k in list(obj.keys()):
                if k.startswith("_"):
                    del obj[k]
                else:
                    _strip(obj[k])
        elif isinstance(obj, list):
            if id(obj) in visited:
                return
            visited.add(id(obj))
            for item in obj:
                _strip(item)

    _strip(data)


def convert_file(skel_path: Union[str, "os.PathLike[str]"], json_path: Optional[Union[str, "os.PathLike[str]"]] = None) -> str:
    """Convert a .skel file to JSON. Returns the output path."""
    skel_path = str(skel_path)
    if json_path is None:
        json_path = os.path.splitext(skel_path)[0] + ".json"
    try:
        data = skel_to_json(skel_path)
    except ParseError as e:
        logger.error("ParseError converting %s: %s", skel_path, e)
        raise ParseError(f"Failed to parse {skel_path}: {e}")
    except Exception as e:
        logger.error("Unexpected error converting %s: %s", skel_path, e, exc_info=True)
        raise
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return json_path


if __name__ == "__main__":
    import sys as _sys
    if len(_sys.argv) < 2:
        print("Usage: python skel2json.py input.skel [output.json]")
        raise SystemExit(1)
    try:
        data = convert_file(_sys.argv[1], _sys.argv[2] if len(_sys.argv) > 2 else None)
    except ParseError as e:
        raise ParseError(f"Failed to parse {_sys.argv[1]}: {e}")
    except Exception:
        import traceback
        traceback.print_exc()
        raise
    print("Written:", _sys.argv[2] if len(_sys.argv) > 2 else os.path.splitext(_sys.argv[1])[0] + ".json")
