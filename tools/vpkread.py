import struct, sys, os
def read_cstr(f):
    b=bytearray()
    while True:
        c=f.read(1)
        if c in (b'\0',b''): return b.decode('utf-8','replace')
        b+=c
def index(path):
    out={}
    with open(path,'rb') as f:
        sig,ver,treesize=struct.unpack('<III',f.read(12))
        assert sig==0x55aa1234
        if ver==2: f.read(16)
        hdr=f.tell(); 
        while True:
            ext=read_cstr(f)
            if not ext: break
            while True:
                d=read_cstr(f)
                if not d: break
                while True:
                    n=read_cstr(f)
                    if not n: break
                    crc,pre,arc,off,ln,term=struct.unpack('<IHHIIH',f.read(18))
                    predata=f.read(pre)
                    name=(d.strip()+'/' if d.strip() else '')+n+'.'+ext
                    out[name]=(arc,off,ln,predata)
        dataoff=hdr+treesize
    return out,dataoff
def read(path,name,idx=None):
    idx,dataoff=idx or index(path)
    arc,off,ln,pre=idx[name]
    if arc==0x7fff:
        with open(path,'rb') as f: f.seek(dataoff+off); return pre+f.read(ln)
    ap=path.replace('_dir.vpk','_%03d.vpk'%arc)
    with open(ap,'rb') as f: f.seek(off); return pre+f.read(ln)
if __name__=='__main__':
    cmd=sys.argv[1]; p=sys.argv[2]
    ix=index(p)
    if cmd=='ls':
        pat=sys.argv[3] if len(sys.argv)>3 else ''
        for k in sorted(ix[0]):
            if pat in k: print(k)
    elif cmd=='x':
        outdir=sys.argv[3]
        for n in sys.argv[4:]:
            data=read(p,n,ix); o=os.path.join(outdir,n); os.makedirs(os.path.dirname(o),exist_ok=True); open(o,'wb').write(data)
