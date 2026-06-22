# LED 알고리즘 스트레스 테스트 — 합성도형 + 폰트 글리프(한글/필기체/영문) 수십종으로 검증.
import math, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.textpath import TextPath
from matplotlib.font_manager import FontProperties
import led_lab as L

FONTS = {
    'arial':'C:/Windows/Fonts/arial.ttf',
    'ariblk':'C:/Windows/Fonts/ariblk.ttf',
    'times':'C:/Windows/Fonts/times.ttf',
    'script':'C:/Windows/Fonts/segoesc.ttf',
    'malgun':'C:/Windows/Fonts/malgun.ttf',
}

def glyph(ch, font='arial', target_h=200.0):
    tp=TextPath((0,0), ch, size=220, prop=FontProperties(fname=FONTS[font]))
    polys=[[[float(p[0]),float(p[1])] for p in sub] for sub in tp.to_polygons() if len(sub)>=3]
    if not polys: return None
    xs=[p[0] for poly in polys for p in poly]; ys=[p[1] for poly in polys for p in poly]
    h=(max(ys)-min(ys)) or 1; s=target_h/h
    return [[[(p[0]-min(xs))*s,(p[1]-min(ys))*s] for p in poly] for poly in polys]

# ---- 합성 도형 ----
def circle(r=120,n=56,cx=0,cy=0):
    return [[[cx+r*math.cos(2*math.pi*k/n),cy+r*math.sin(2*math.pi*k/n)] for k in range(n)]]
def ring(ro=130,ri=65,n=56):
    return circle(ro,n)+[[[ri*math.cos(2*math.pi*k/n),ri*math.sin(2*math.pi*k/n)] for k in range(n)]]
def rect(w,h):
    return [[[0,0],[w,0],[w,h],[0,h]]]
def star(R=140,r=58,n=5):
    pts=[]
    for k in range(2*n):
        rad=R if k%2==0 else r; a=math.pi/2+math.pi*k/n
        pts.append([rad*math.cos(a),rad*math.sin(a)])
    return [pts]
def plus(arm=160,th=46):
    a=arm; t=th/2
    return [[[-t,-a],[t,-a],[t,-t],[a,-t],[a,t],[t,t],[t,a],[-t,a],[-t,t],[-a,t],[-a,-t],[-t,-t]]]
def scurve(L_=420,amp=80,wid=44,n=60):
    top=[]; bot=[]
    for k in range(n+1):
        x=L_*k/n; y=amp*math.sin(math.pi*2*k/n)
        # normal offset (approx vertical)
        top.append([x,y+wid/2]); bot.append([x,y-wid/2])
    return [top+bot[::-1]]
def diagbar(L_=320,wid=40,ang=35):
    a=math.radians(ang); dx=math.cos(a); dy=math.sin(a); nx=-dy; ny=dx
    p0=[0,0]; p1=[L_*dx,L_*dy]
    return [[[p0[0]+nx*wid/2,p0[1]+ny*wid/2],[p1[0]+nx*wid/2,p1[1]+ny*wid/2],
             [p1[0]-nx*wid/2,p1[1]-ny*wid/2],[p0[0]-nx*wid/2,p0[1]-ny*wid/2]]]

SHAPES = {
 'rect_wide':rect(340,120),'rect_thin':rect(340,36),'rect_tall':rect(120,340),
 'circle':circle(),'ring':ring(),'star':star(),'plus':plus(),'scurve':scurve(),'diag':diagbar(),
}
GLYPHS = {
 'A_blk':glyph('A','ariblk'),'B_blk':glyph('B','ariblk'),'E_blk':glyph('E','ariblk'),
 'O_blk':glyph('O','ariblk'),'R_blk':glyph('R','ariblk'),'S_blk':glyph('S','ariblk'),
 'g_times':glyph('g','times'),'e_times':glyph('e','times'),'8_arial':glyph('8','arial'),
 'a_script':glyph('a','script'),'S_script':glyph('S','script'),'e_script':glyph('e','script'),
 '가':glyph('가','malgun'),'한':glyph('한','malgun'),'글':glyph('글','malgun'),
 'ㅇ':glyph('ㅇ','malgun'),'ㅁ':glyph('ㅁ','malgun'),'ㅂ':glyph('ㅂ','malgun'),
 '별':glyph('★','arial') or star(),
}

def metrics(polys, spec):
    res=L.place(polys,spec)
    chain=res[0]; placed=res[2] if len(res)>2 else len(chain); total=res[3] if len(res)>3 else len(chain)
    wire=spec['wire']
    longleads=0; gaps=[]
    for k in range(len(chain)-1):
        d=math.hypot(chain[k+1][0]-chain[k][0],chain[k+1][1]-chain[k][1]); gaps.append(d)
        if d>wire+spec['w']*0.2: longleads+=1
    import statistics
    sd=statistics.pstdev(gaps) if len(gaps)>1 else 0
    cov=placed/total if total else 1
    return dict(placed=placed,total=total,cov=cov,longleads=longleads,gapsd=sd)

def montage(items, spec, fname, cols=5):
    n=len(items); rows=math.ceil(n/cols)
    fig,axs=plt.subplots(rows,cols,figsize=(cols*2.7,rows*2.7))
    axs=axs.flatten()
    for i,(name,polys) in enumerate(items):
        if not polys: axs[i].axis('off'); continue
        L.draw_letter(axs[i],polys,spec)
        m=metrics(polys,spec)
        axs[i].set_title(f"{name} {m['placed']}/{m['total']} cov{m['cov']*100:.0f}% lead{m['longleads']}",fontsize=7)
    for i in range(n,len(axs)): axs[i].axis('off')
    plt.tight_layout(); plt.savefig(fname,dpi=85); plt.close(); print('saved',fname)

import led_creatures as C
def _scale(polys,h=360.0):
    ys=[p[1] for poly in polys for p in poly]; xs=[p[0] for poly in polys for p in poly]
    hh=(max(ys)-min(ys)) or 1; s=h/hh
    return [[[(p[0]-min(xs))*s,(p[1]-min(ys))*s] for p in poly] for poly in polys]
CREAT={k:_scale(v) for k,v in C.CREATURES.items()}

ALL = list(SHAPES.items())+list(GLYPHS.items())+list(CREAT.items())
ALL = [(n,p) for n,p in ALL if p]

def score_all(spec):
    tot=0.0; cov_sum=0.0; details=[]
    pitch=spec['w']+spec['wire']*0.4
    for name,polys in ALL:
        res=L.place(polys,spec); chain=res[0]
        placed=res[2] if len(res)>2 else len(chain); total=res[3] if len(res)>3 else len(chain)
        if len(chain)<2: continue
        wirelen=sum(math.hypot(chain[k+1][0]-chain[k][0],chain[k+1][1]-chain[k][1]) for k in range(len(chain)-1))
        avgstep=wirelen/(len(chain)-1)
        cov=placed/total if total else 1
        sc=avgstep/pitch + (1-cov)*8
        tot+=sc; cov_sum+=cov; details.append((name,avgstep/pitch,cov))
    return tot, cov_sum/len(ALL), details

def sweep():
    L.CAP_STEPS[0]=40000
    best=None
    for dist in (0.6,1.0,1.5,2.2):
        for bend in (0.0,0.3,0.6,1.0):
            for deg in (0.0,0.2,0.5,0.9):
                L.W.update(dist=dist,bend=bend,deg=deg)
                tot,cov,_=score_all(L.SPECS['mini3'])
                if best is None or tot<best[0]:
                    best=(tot,dict(dist=dist,bend=bend,deg=deg),cov)
    print('BEST',best[1],'score%.1f'%best[0],'cov%.0f%%'%(best[2]*100))
    return best[1]

if __name__=='__main__':
    import sys
    sp=L.SPECS['mini3']
    if len(sys.argv)>1 and sys.argv[1]=='sweep':
        bw=sweep(); L.W.update(**bw); L.CAP_STEPS[0]=300000
        print('rendering with',bw)
    montage(list(SHAPES.items()),sp,'scripts/stress_shapes.png')
    montage(list(GLYPHS.items()),sp,'scripts/stress_glyphs.png')
    montage(list(CREAT.items()),sp,'scripts/stress_creatures.png',cols=3)
    # summary table
    print('\n=== metrics (mini3) ===')
    allit=list(SHAPES.items())+list(GLYPHS.items())
    bad=[]
    for name,polys in allit:
        if not polys: continue
        m=metrics(polys,sp)
        flag=''
        if m['cov']<0.92: flag+=' LOWCOV'
        if m['longleads']>2: flag+=' LEADS'
        print(f"{name:10s} placed {m['placed']:3d}/{m['total']:3d} cov{m['cov']*100:5.0f}% leads{m['longleads']:2d} gapSD{m['gapsd']:5.1f}{flag}")
        if flag: bad.append(name)
    print('\nPROBLEM:',bad)
