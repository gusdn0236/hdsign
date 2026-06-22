# 절차적 동물/로고 실루엣 — 넓은 몸통 + 가는 다리/꼬리/귀/가시(알고리즘 최난도). 마스크→윤곽.
import math, numpy as np, cv2

def _mask(draw, S=600, pad=40):
    img=np.zeros((S,S),np.uint8); draw(img); return img

def _contours(img, scale=1.0, simplify=2.0):
    cs,_=cv2.findContours(img,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    polys=[]
    for c in cs:
        if cv2.contourArea(c)<150: continue
        c=cv2.approxPolyDP(c,simplify,True)
        polys.append([[float(p[0][0])*scale, float(-p[0][1])*scale] for p in c])  # y flip → DXF up
    return polys

def capsule(img,p0,p1,r,col=255):
    cv2.line(img,(int(p0[0]),int(p0[1])),(int(p1[0]),int(p1[1])),col,int(r*2))
    for p in (p0,p1): cv2.circle(img,(int(p[0]),int(p[1])),int(r),col,-1)
def ell(img,c,ax,ang=0,col=255):
    cv2.ellipse(img,(int(c[0]),int(c[1])),(int(ax[0]),int(ax[1])),ang,0,360,col,-1)

def cat():
    def d(img):
        ell(img,(300,360),(150,95))          # body
        ell(img,(430,250),(70,65))            # head
        cv2.fillPoly(img,[np.array([[400,200],[420,120],[455,190]])],255)  # ear
        cv2.fillPoly(img,[np.array([[460,200],[470,120],[495,195]])],255)  # ear
        for lx in (210,290,360,430): capsule(img,(lx,440),(lx,520),16)     # legs
        # tail
        pts=[(160,360),(110,300),(120,230),(170,200)]
        for a,b in zip(pts,pts[1:]): capsule(img,a,b,14)
    return _contours(_mask(d))

def dog():
    def d(img):
        ell(img,(300,360),(165,90))           # body
        ell(img,(450,300),(80,62))            # head
        capsule(img,(500,300),(540,320),22)   # snout
        cv2.fillPoly(img,[np.array([[400,250],[395,330],[440,300]])],255)  # ear (floppy)
        for lx in (200,280,370,450): capsule(img,(lx,440),(lx,525),18)
        capsule(img,(150,350),(90,300),15)    # tail
    return _contours(_mask(d))

def hedgehog():
    def d(img):
        ell(img,(300,380),(170,110))          # body
        ell(img,(460,400),(60,55))            # face
        for k in range(16):                   # spikes
            a=math.pi*(0.15+0.7*k/15); cx=300-30*math.cos(a); cy=300
            tx=cx+ -math.cos(a)*150 + (k-8)*10; ty=300-150-abs(k-8)*4
            base=(int(180+ k*16),300); tip=(int(180+k*16),150+ (abs(k-7))*6)
            cv2.fillPoly(img,[np.array([[base[0]-9,base[1]],[base[0]+9,base[1]],[tip[0],tip[1]]])],255)
        for lx in (250,330): capsule(img,(lx,470),(lx,520),14)
    return _contours(_mask(d))

def dragon():
    def d(img):
        pts=[(120,420),(200,360),(300,400),(400,330),(480,360),(540,300)]  # wavy body
        for a,b in zip(pts,pts[1:]): capsule(img,a,b,30)
        ell(img,(540,300),(55,45))            # head
        for k in range(6):                    # back spikes
            x=160+k*70; cv2.fillPoly(img,[np.array([[x-14,360-k*5],[x+14,360-k*5],[x,300-k*8]])],255)
        for lx in (220,360): capsule(img,(lx,430),(lx,510),16)  # legs
        capsule(img,(120,420),(70,470),12)    # tail tip
    return _contours(_mask(d))

def bird():
    def d(img):
        ell(img,(300,360),(120,80),20)        # body
        ell(img,(420,300),(55,50))            # head
        cv2.fillPoly(img,[np.array([[465,300],[520,290],[470,320]])],255)  # beak
        cv2.fillPoly(img,[np.array([[260,330],[180,260],[300,330]])],255)  # wing
        for lx in (290,330): capsule(img,(lx,430),(lx,500),9)  # thin legs
        capsule(img,(190,380),(120,420),16)   # tail
    return _contours(_mask(d))

def rabbit():
    def d(img):
        ell(img,(300,400),(110,90))           # body
        ell(img,(300,260),(60,60))            # head
        capsule(img,(280,210),(265,90),22)    # ear
        capsule(img,(320,210),(340,95),22)    # ear
        for lx in (250,350): capsule(img,(lx,470),(lx,520),16)
        cv2.circle(img,(210,420),22,255,-1)   # tail puff
    return _contours(_mask(d))

def fish():
    def d(img):
        ell(img,(300,360),(150,80))           # body
        cv2.fillPoly(img,[np.array([[150,360],[60,300],[60,420]])],255)   # tail fin
        cv2.fillPoly(img,[np.array([[300,290],[330,210],[360,290]])],255) # top fin
        cv2.circle(img,(400,345),8,0,-1)      # eye (hole)
    return _contours(_mask(d))

def blob_wide():
    def d(img):
        ell(img,(300,300),(220,120))
        for lx in (180,420): capsule(img,(lx,380),(lx,470),20)
    return _contours(_mask(d))

def blob_narrow():
    def d(img):
        capsule(img,(300,120),(300,480),55)   # tall narrow body
        capsule(img,(300,200),(420,170),22)   # arm
        capsule(img,(300,360),(190,400),22)   # arm
    return _contours(_mask(d))

CREATURES={'cat':cat(),'dog':dog(),'hedgehog':hedgehog(),'dragon':dragon(),
           'bird':bird(),'rabbit':rabbit(),'fish':fish(),'blobW':blob_wide(),'blobN':blob_narrow()}

if __name__=='__main__':
    for k,v in CREATURES.items(): print(k,'polys',len(v),'pts',sum(len(p) for p in v))
