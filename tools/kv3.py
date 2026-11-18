"""Minimal binary KV3 (version 5) reader/writer for Source 2 resources.

Values are decoded into Node objects that remember their on-disk type so a
parsed resource can be modified and re-encoded faithfully.
"""
import struct
import lz4blk

NULL, BOOL, INT64, UINT64, DOUBLE, STRING, BLOB, ARRAY, OBJECT, ARRAY_TYPED = range(1, 11)
INT32, UINT32, B_TRUE, B_FALSE, I64_ZERO, I64_ONE, D_ZERO, D_ONE, FLOAT = range(11, 20)
INT16, UINT16, T22, T23, ARR_BYTELEN, ARR_AUX, U32_ZERO, U32_ONE = range(20, 28)

SIZES = {BOOL: 1, INT64: 8, UINT64: 8, DOUBLE: 8, STRING: 4, INT32: 4, UINT32: 4,
         FLOAT: 4, INT16: 2, UINT16: 2, T22: 1, T23: 1}
FMT = {BOOL: '<B', INT64: '<q', UINT64: '<Q', DOUBLE: '<d', STRING: '<i', INT32: '<i',
       UINT32: '<I', FLOAT: '<f', INT16: '<h', UINT16: '<H', T22: '<b', T23: '<B'}
CONST = {U32_ZERO: 0, U32_ONE: 1, B_TRUE: True, B_FALSE: False, I64_ZERO: 0, I64_ONE: 1, D_ZERO: 0.0, D_ONE: 1.0, NULL: None}


class Node:
    __slots__ = ('t', 'v', 'flag', 'sub', 'subflag')

    def __init__(self, t, v, flag=None, sub=None, subflag=None):
        self.t, self.v, self.flag, self.sub, self.subflag = t, v, flag, sub, subflag

    def __repr__(self):
        return 'Node(%d,%r)' % (self.t, self.v if not isinstance(self.v, (bytes, list, dict)) else type(self.v).__name__)

    def __getitem__(self, k):
        return self.v[k]

    def __setitem__(self, k, val):
        self.v[k] = val


def plain(n):
    """Convert a Node tree to plain python values."""
    if isinstance(n, Node):
        if n.t == OBJECT:
            return {k: plain(v) for k, v in n.v.items()}
        if isinstance(n.v, list):
            return [plain(x) for x in n.v]
        return n.v
    return n


class _Stream:
    def __init__(self, data, b1, b2, b4, b8):
        self.d = data
        self.p = {1: b1[0], 2: b2[0], 4: b4[0], 8: b8[0]}

    def read(self, size, fmt):
        v = struct.unpack_from(fmt, self.d, self.p[size])[0]
        self.p[size] += size
        return v


def _layout(start, c1, c2, c4, c8):
    # lanes are only aligned when they actually hold values (matches Valve's compiler)
    a = start
    r1 = (a, a + c1); a += c1
    if c2:
        a = (a + 1) & ~1
    r2 = (a, a + 2 * c2); a += 2 * c2
    if c4:
        a = (a + 3) & ~3
    r4 = (a, a + 4 * c4); a += 4 * c4
    if c8:
        a = (a + 7) & ~7
    r8 = (a, a + 8 * c8); a += 8 * c8
    return r1, r2, r4, r8, a


HDR = '<4s16sIHHIIIIHHIIIIII12I'


def decode(data):
    f = list(struct.unpack_from(HDR, data, 0))
    magic, guid, comp, dict_id, frame, c1, c4, c8, ctypes, cobj, carr, unc_tot, comp_tot, nblocks, blobbytes, c2, bsizes = f[:17]
    (unc1, cmp1, unc2, cmp2, c1b, c2b, c4b, c8b, types2, cobj2, carr2, unk16) = f[17:]
    assert magic == b'\x053VK', magic
    p = struct.calcsize(HDR)
    if comp == 1:
        buf1 = lz4blk.decompress(data[p:p + cmp1]); p += cmp1
        buf2 = lz4blk.decompress(data[p:p + cmp2]); p += cmp2
    elif comp == 2:
        from compression import zstd
        buf1 = zstd.decompress(data[p:p + cmp1]); p += cmp1
        buf2 = zstd.decompress(data[p:p + cmp2]); p += cmp2
    elif comp == 0:
        buf1 = data[p:p + unc1]; p += unc1
        buf2 = data[p:p + unc2]; p += unc2
    else:
        raise ValueError('unsupported compression %d' % comp)
    assert len(buf1) == unc1 and len(buf2) == unc2
    # buffer1: strings live in the 1-byte region; 4-byte region starts with string count
    r1, r2, r4, r8, _ = _layout(0, c1, c2, c4, c8)
    nstr = struct.unpack_from('<I', buf1, r4[0])[0]
    strings, q = [], r1[0]
    for _ in range(nstr):
        e = buf1.index(b'\0', q)
        strings.append(buf1[q:e].decode('utf-8'))
        q = e + 1
    aux = _Stream(buf1, (q, 0), r2, (r4[0] + 4, 0), r8)
    # buffer2: object member counts, value streams, types, blob sizes, trailer
    oc = struct.unpack_from('<%dI' % cobj2, buf2, 0)
    s1, s2, s4, s8, tstart = _layout(4 * cobj2, c1b, c2b, c4b, c8b)
    main = _Stream(buf2, s1, s2, s4, s8)
    types = buf2[tstart:tstart + ctypes]
    q = tstart + ctypes
    blob_sizes = struct.unpack_from('<%dI' % nblocks, buf2, q); q += 4 * nblocks
    if q + 4 <= len(buf2):
        trailer = struct.unpack_from('<I', buf2, q)[0]; q += 4
    else:  # some compilers put the trailer after the compressed buffers when there are no blobs
        trailer = struct.unpack_from('<I', data, p)[0] if p + 4 <= len(data) else 0xFFEEDD00
    assert trailer == 0xFFEEDD00, hex(trailer)
    blob_csizes = struct.unpack_from('<%dH' % (bsizes // 2), buf2, q) if bsizes else ()
    # blobs
    blobdata = b''
    if nblocks:
        if comp == 1:
            out = bytearray()
            for cs in blob_csizes:
                out += lz4blk.decompress(data[p:p + cs], prefix=bytes(out[-65536:]))
                p += cs
            blobdata = bytes(out)
        elif comp == 2:
            from compression import zstd
            dec = zstd.ZstdDecompressor()
            blobdata = dec.decompress(data[p:])
            p = len(data) - len(dec.unused_data)
        else:
            blobdata = data[p:p + blobbytes]; p += blobbytes
    st = {'t': 0, 'o': 0, 'blob': 0, 'bi': 0}

    def rtype():
        t = types[st['t']]; st['t'] += 1
        fl = None
        if t & 0x80:
            t &= 0x7f
            fl = types[st['t']]; st['t'] += 1
        return t, fl

    def scalar(t, s):
        if t in CONST:
            return CONST[t]
        if t == STRING:
            i = main.read(4, '<i')
            return '' if i == -1 else strings[i]
        if t == BLOB:
            n = blob_sizes[st['bi']]; st['bi'] += 1
            b = blobdata[st['blob']:st['blob'] + n]; st['blob'] += n
            return b
        return s.read(SIZES[t], FMT[t])

    def value(t, fl, s):
        if t == OBJECT:
            n = oc[st['o']]; st['o'] += 1
            d = {}
            for _ in range(n):
                name = strings[main.read(4, '<i')]
                ct, cf = rtype()
                d[name] = value(ct, cf, main)
            return Node(OBJECT, d, fl)
        if t == ARRAY:
            n = main.read(4, '<i')
            items = []
            for _ in range(n):
                ct, cf = rtype()
                items.append(value(ct, cf, main))
            return Node(ARRAY, items, fl)
        if t in (ARRAY_TYPED, ARR_BYTELEN, ARR_AUX):
            n = main.read(4, '<i') if t == ARRAY_TYPED else main.read(1, '<B')
            st_, sf = rtype()
            src = aux if t == ARR_AUX else main
            items = [value(st_, sf, src) for _ in range(n)]
            return Node(t, items, fl, st_, sf)
        return Node(t, scalar(t, s), fl)

    rt, rf = rtype()
    root = value(rt, rf, main)
    assert st['t'] == ctypes and st['o'] == cobj2, (st, ctypes, cobj2)
    return root, guid


class _Writer:
    def __init__(self):
        self.strings, self.sidx = [], {}
        self.main = {1: bytearray(), 2: bytearray(), 4: bytearray(), 8: bytearray()}
        self.aux = {1: bytearray(), 2: bytearray(), 4: bytearray(), 8: bytearray()}
        self.types = bytearray()
        self.oc = []
        self.blobs = []
        self.nobj = 0
        self.narr = 0
        self.elems_hint = 0

    def s(self, txt):
        if txt not in self.sidx:
            self.sidx[txt] = len(self.strings); self.strings.append(txt)
        return self.sidx[txt]

    def wtype(self, t, fl):
        if fl is not None:
            self.types += bytes([t | 0x80, fl])
        else:
            self.types.append(t)

    def scalar(self, t, v, buf):
        if t in CONST:
            return
        if t == STRING:
            self.main[4] += struct.pack('<i', -1 if v == '' else self.s(v))
        elif t == BLOB:
            self.blobs.append(bytes(v))
        else:
            buf[SIZES[t]] += struct.pack(FMT[t], v)

    def value(self, n, buf):
        t = n.t
        if t in (OBJECT, ARRAY, ARRAY_TYPED, ARR_BYTELEN, ARR_AUX):
            if t != OBJECT:
                self.elems_hint += len(n.v)
            buf = self.main
        if t == OBJECT:
            self.oc.append(len(n.v)); self.nobj += 1
            for k, c in n.v.items():
                buf[4] += struct.pack('<i', self.s(k))
                self.wtype(c.t, c.flag)
                self.value(c, buf)
        elif t == ARRAY:
            self.narr += 1
            buf[4] += struct.pack('<i', len(n.v))
            for c in n.v:
                self.wtype(c.t, c.flag)
                self.value(c, buf)
        elif t in (ARRAY_TYPED, ARR_BYTELEN, ARR_AUX):
            self.narr += 1
            if t != ARRAY_TYPED and len(n.v) > 255:
                # byte-length arrays hold at most 255 items; fall back to an int32-counted typed array
                t = ARRAY_TYPED
                self.types[-1:] = b''  # caller already wrote our type byte (no flag on these arrays)
                self.types.append(ARRAY_TYPED)
            if t == ARRAY_TYPED:
                buf[4] += struct.pack('<i', len(n.v))
            else:
                assert len(n.v) < 256, 'byte-length array too long'
                buf[1] += struct.pack('<B', len(n.v))
            self.wtype(n.sub, n.subflag)
            dst = self.aux if t == ARR_AUX else self.main
            for c in n.v:
                if c.t != n.sub:
                    # every element of a typed array is stored as the array's element type
                    if n.sub in CONST or c.t in (OBJECT, ARRAY, ARRAY_TYPED, ARR_BYTELEN, ARR_AUX):
                        raise ValueError('typed array element type %d does not match %d' % (c.t, n.sub))
                    c = Node(n.sub, c.v)
                self.value(c, dst)
        else:
            self.scalar(t, n.v, buf)


def _pack_streams(b, prefix=b''):
    out = bytearray(prefix)
    out += b[1]
    if b[2]:
        while len(out) % 2: out.append(0)
    out += b[2]
    if b[4]:
        while len(out) % 4: out.append(0)
    out += b[4]
    if b[8]:
        while len(out) % 8: out.append(0)
    out += b[8]
    return out


def lz4_literal_block(data):
    """A valid LZ4 block that stores everything as literals (no matches)."""
    n = len(data)
    out = bytearray()
    if n >= 15:
        out.append(0xF0)
        r = n - 15
        while r >= 255:
            out.append(255); r -= 255
        out.append(r)
    else:
        out.append(n << 4)
    out += data
    return bytes(out)


def encode(root, guid, compress=True, frame=16384):
    """Encode a Node tree as a KV3 v5 blob (LZ4 container, literal-only blocks)."""
    w = _Writer()
    w.wtype(root.t, root.flag)
    w.value(root, w.main)
    strbytes = b''.join(x.encode('utf-8') + b'\0' for x in w.strings)
    # buffer1: strings in the byte region, string count first in 4-byte region
    a1 = dict(w.aux)
    a1[1] = bytearray(strbytes) + w.aux[1]
    a1[4] = bytearray(struct.pack('<I', len(w.strings))) + w.aux[4]
    buf1 = _pack_streams(a1)
    blob = b''.join(w.blobs)
    buf2 = bytearray(struct.pack('<%dI' % len(w.oc), *w.oc))
    buf2 = _pack_streams(w.main, buf2)
    buf2 += w.types
    buf2 += struct.pack('<%dI' % len(w.blobs), *[len(x) for x in w.blobs])
    buf2 += struct.pack('<I', 0xFFEEDD00)
    blob_out, csizes = blob, []
    if compress:
        # each blob is split into its own frames; frames never span two blobs (matches Valve's files)
        parts = [lz4_literal_block(b[i:i + frame]) for b in w.blobs for i in range(0, len(b), frame)]
        csizes = [len(p) for p in parts]
        blob_out = b''.join(parts)
        buf2 += struct.pack('<%dH' % len(csizes), *csizes)
        c1, c2 = lz4_literal_block(bytes(buf1)), lz4_literal_block(bytes(buf2))
    else:
        c1, c2 = bytes(buf1), bytes(buf2)
    hdr = struct.pack(HDR, b'\x053VK', guid, 1 if compress else 0, 0, frame if compress else 0,
                      len(a1[1]), len(a1[4]) // 4, len(a1[8]) // 8,
                      len(w.types), w.nobj, w.narr,
                      len(buf1) + len(buf2), len(c1) + len(c2), len(w.blobs), len(blob), len(a1[2]) // 2, 2 * len(csizes),
                      len(buf1), len(c1), len(buf2), len(c2),
                      len(w.main[1]), len(w.main[2]) // 2, len(w.main[4]) // 4, len(w.main[8]) // 8,
                      len(w.types), w.nobj, w.narr, w.elems_hint)
    return hdr + c1 + c2 + blob_out + struct.pack('<I', 0xFFEEDD00)
