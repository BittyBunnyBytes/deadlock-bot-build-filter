def decompress(src, out_size=None, prefix=b''):
    dst=bytearray(prefix); i=0; n=len(src)
    while i<n:
        tok=src[i]; i+=1
        lit=tok>>4
        if lit==15:
            while True:
                b=src[i]; i+=1; lit+=b
                if b!=255: break
        dst+=src[i:i+lit]; i+=lit
        if i>=n: break
        off=src[i]|(src[i+1]<<8); i+=2
        ml=tok&15
        if ml==15:
            while True:
                b=src[i]; i+=1; ml+=b
                if b!=255: break
        ml+=4
        s=len(dst)-off
        if off>=ml: dst+=dst[s:s+ml]
        else:
            for k in range(ml): dst.append(dst[s+k])
    return bytes(dst[len(prefix):])
