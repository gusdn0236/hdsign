# LED 배치 실험대 — 주문-260622-05 의 FILA / UNDERWEAR 실제 벡터로 알고리즘을 시각 검증.
import json, math, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly, Rectangle, Circle
import matplotlib.transforms as mtransforms

D = json.load(open('scripts/led_geom_05.json', encoding='utf-8'))
OBJS = D['objects']
BEND = 0.9
SPECS = {
    'g3':   dict(name='3구',    w=68, h=15, bulbs=3, wire=80, color='#e23b3b'),
    'm2':   dict(name='미들2구', w=43, h=15, bulbs=2, wire=65, color='#ee9b00'),
    'mini3':dict(name='미니3구', w=30, h=10, bulbs=3, wire=40, color='#0a9396'),
    'g1':   dict(name='1구',    w=13, h=10, bulbs=1, wire=25, color='#7b2cbf'),
}

def bbox(polys):
    xs=[p[0] for poly in polys for p in poly]; ys=[p[1] for poly in polys for p in poly]
    return min(xs),min(ys),max(xs),max(ys)

def pip(polys, x, y):
    inside=False
    for poly in polys:
        n=len(poly); j=n-1
        for i in range(n):
            yi=poly[i][1]; yj=poly[j][1]
            if (yi>y)!=(yj>y):
                xint=poly[i][0]+(y-yi)/(yj-yi)*(poly[j][0]-poly[i][0])
                if x<xint: inside=not inside
            j=i
    return inside

# ---- letter grouping (frontend과 동일) ----
def enc(a,b):
    return (a['x']<=b['x']+0.5 and a['y']<=b['y']+0.5 and a['x']+a['w']>=b['x']+b['w']-0.5
            and a['y']+a['h']>=b['y']+b['h']-0.5 and a['w']*a['h']>b['w']*b['h'])
def letters_in(x0,x1,y0,y1):
    idx=[i for i,o in enumerate(OBJS) if x0<=o['x']+o['w']/2<=x1 and y0<=o['y']+o['h']/2<=y1 and len(o.get('points',[]))>=2]
    def depth(i): return sum(1 for j in idx if j!=i and enc(OBJS[j],OBJS[i]))
    roots=[i for i in idx if depth(i)%2==0]
    out=[]
    for root in sorted(roots,key=lambda i:OBJS[i]['x']):
        holes=[]
        for h in idx:
            if depth(h)%2==1:
                cont=[j for j in idx if j!=h and enc(OBJS[j],OBJS[h])]
                if cont and min(cont,key=lambda k:OBJS[k]['w']*OBJS[k]['h'])==root: holes.append(h)
        polys=[OBJS[root]['points']]+[OBJS[h]['points'] for h in holes]
        out.append(polys)
    return out

FILA = letters_in(250,1950,600,1160)
UNDER = letters_in(250,1800,320,500)
print('FILA',len(FILA),'UNDERWEAR',len(UNDER))

# =====================================================================
# 배치 알고리즘 (여기를 고쳐가며 실험). 반환: chain = [(x,y),...] 모듈 중심 순서 + vertical
# =====================================================================
DIRV={'N':(0,1),'S':(0,-1),'E':(1,0),'W':(-1,0)}
W=dict(dist=1.5,bend=0.6,deg=0.5)  # 링크 선택 가중치(실데이터 스윕 최적)
MIND=[0.9]  # 모듈 최소 중심간격 = 본체 × MIND (씨닝)
CAP_STEPS=[300000]  # DFS 스텝 상한(스윕시 낮춤)

def place(polys, spec, exitDir='S'):
    w=spec['w']; h=spec['h']; wire=spec['wire']; maxRow=wire*BEND; maxLink=w+wire+2
    v=DIRV[exitDir]
    minx,miny,maxx,maxy=bbox(polys)
    vertical = (maxy-miny) > (maxx-minx)
    if vertical:
        P=[[[p[1],p[0]] for p in poly] for poly in polys]
    else:
        P=polys
    bminx,bminy,bmaxx,bmaxy=bbox(P); bw=bmaxx-bminx; bh=bmaxy-bminy
    real=(lambda sx,sy:(sy,sx)) if vertical else (lambda sx,sy:(sx,sy))
    # 스캔라인: 각 행에서 '획 단면(span)'을 찾아 그 안에 모듈을 깐다(가는 획·빗살도 덮음).
    def spans_at(Q,y):
        xs=[]
        for poly in Q:
            n=len(poly)
            for i in range(n):
                a=poly[i]; b=poly[(i+1)%n]; y1=a[1]; y2=b[1]
                if (y1<=y<y2) or (y2<=y<y1):
                    t=(y-y1)/(y2-y1); xs.append(a[0]+t*(b[0]-a[0]))
        xs.sort()
        return [(xs[i],xs[i+1]) for i in range(0,len(xs)-1,2)]
    nrows=max(1,round(bh/(maxRow*0.5))); rowStep=bh/nrows   # 촘촘 스캔(곡선 포착) → 아래서 씨닝
    G=[]
    for r in range(nrows):
        cy=bminy+rowStep*(r+0.5)
        for (a,e) in spans_at(P,cy):
            sw=e-a
            if sw < w*0.55:
                G.append(((a+e)/2,cy)); continue
            tp=w+wire*0.35
            nx=max(1,round(sw/tp)); nx=max(nx,math.ceil(sw/(w+wire)))
            while sw/(nx+1)>=w*0.85 and sw/nx>w+wire*0.5: nx+=1   # 균일밝기: 1개 가운데(양옆 어둠) 대신 2줄로
            while nx>1 and sw/nx<w*0.9: nx-=1
            inset=min(w/2,sw/2-1); lo=a+inset; hi=e-inset
            for c in range(nx):
                G.append(((a+e)/2 if nx==1 else lo+(hi-lo)*c/(nx-1), cy))
    # 최소 중심간격으로 솎아내기 — 모듈이 서로 너무 붙지 않게(꺾는곳 제외 일정 간격).
    mind2=(w*MIND[0])**2
    kept=[]
    for p in G:
        ok=True
        for q in kept:
            if (p[0]-q[0])**2+(p[1]-q[1])**2 < mind2: ok=False; break
        if ok: kept.append(p)
    G=kept
    N=len(G)
    if N==0: return [], vertical
    if N==1: return [real(*G[0])], vertical
    def linkOK(i,j):
        ax,ay=G[i]; cx,cy=G[j]
        if math.hypot(cx-ax,cy-ay)>maxLink: return False
        for t in (0.15,0.3,0.5,0.7,0.85):
            if not pip(P,ax+(cx-ax)*t,ay+(cy-ay)*t): return False
        return True
    adj=[[] for _ in range(N)]
    for i in range(N):
        for j in range(i+1,N):
            if linkOK(i,j): adj[i].append(j); adj[j].append(i)
    def escore(sx,sy):
        rx,ry=real(sx,sy); return rx*v[0]+ry*v[1]
    start=min(range(N),key=lambda i:escore(*G[i]))
    # 백트래킹으로 '전부 덮는 단일 경로'(해밀턴 경로) 찾기. 분기순서=직진 우선+Warnsdorff(막다른 이웃 먼저).
    best=[[start]]; steps=[0]; CAP=CAP_STEPS[0]
    def dfs(cur,vis,path,pdx,pdy):
        if len(path)>len(best[0]): best[0]=path[:]
        if len(path)==N: return True
        steps[0]+=1
        if steps[0]>CAP: return False
        nbrs=[j for j in adj[cur] if not vis[j]]
        def key(j):
            deg=sum(1 for k in adj[j] if not vis[k])
            dx=G[j][0]-G[cur][0]; dy=G[j][1]-G[cur][1]; dist=math.hypot(dx,dy) or 1
            bend=(1-(pdx*dx+pdy*dy)/((math.hypot(pdx,pdy) or 1)*dist)) if (pdx or pdy) else 0
            return W['dist']*(dist/maxLink)+W['bend']*bend+W['deg']*deg
        for j in sorted(nbrs,key=key):
            vis[j]=True; path.append(j)
            if dfs(j,vis,path,G[j][0]-G[cur][0],G[j][1]-G[cur][1]): return True
            path.pop(); vis[j]=False
        return False
    vis=[False]*N; vis[start]=True
    import sys; sys.setrecursionlimit(10000)
    dfs(start,vis,[start],0,0)
    order=best[0][:]
    seen=[False]*N
    for i in order: seen[i]=True
    # ---- 남은 모듈을 '모양 안으로만 지나는' 연결로 같은 체인에 이어붙임(분기 되돌림 리드) ----
    def inside_link(i,j,capmul=3.0):
        ax,ay=G[i]; cx,cy=G[j]
        if math.hypot(cx-ax,cy-ay)>maxLink*capmul: return False
        for t in (0.1,0.25,0.4,0.5,0.6,0.75,0.9):
            if not pip(P,ax+(cx-ax)*t,ay+(cy-ay)*t): return False
        return True
    def greedy_extend(s):
        sub=[s]; seen[s]=True; cur=s; pdx=pdy=0
        while True:
            nb=[j for j in adj[cur] if not seen[j]]
            if not nb: break
            def k(j):
                dx=G[j][0]-G[cur][0]; dy=G[j][1]-G[cur][1]; dist=math.hypot(dx,dy) or 1
                deg=sum(1 for q in adj[j] if not seen[q])
                bend=(1-(pdx*dx+pdy*dy)/((math.hypot(pdx,pdy) or 1)*dist)) if (pdx or pdy) else 0
                return W['dist']*(dist/maxLink)+W['bend']*bend+W['deg']*deg
            nxt=min(nb,key=k); pdx=G[nxt][0]-G[cur][0]; pdy=G[nxt][1]-G[cur][1]
            cur=nxt; seen[cur]=True; sub.append(cur)
        return sub
    guard=0
    while sum(not s for s in seen)>0 and guard<N+5:
        guard+=1
        end=order[-1]
        cands=[j for j in range(N) if not seen[j] and inside_link(end,j,3.0)]
        if not cands:
            s0=order[0]
            cands=[j for j in range(N) if not seen[j] and inside_link(s0,j,3.0)]
            if cands: order=order[::-1]; end=order[-1]
        if not cands:
            # 더 멀리(모양 안)라도 시도
            cands=[j for j in range(N) if not seen[j] and inside_link(end,j,6.0)]
            if not cands: break
        nb=min(cands,key=lambda j:math.hypot(G[end][0]-G[j][0],G[end][1]-G[j][1]))
        order += greedy_extend(nb)
    placedN=len(order)
    chain=[real(*G[i]) for i in order]
    # orient end toward exit
    def es(p): return p[0]*v[0]+p[1]*v[1]
    if es(chain[-1])<es(chain[0]): chain=chain[::-1]
    # 모듈 방향 = 국소 PCA(주변 모듈 주축) — 경로 지그재그와 무관하게 한 획 안에선 일관(가로/세로 정렬).
    R=w*1.4
    def pca_angle(k):
        cx,cy=chain[k]; near=[]
        for p in chain:
            dx=p[0]-cx; dy=p[1]-cy
            if dx*dx+dy*dy<=R*R: near.append((dx,dy))
        if len(near)<2: return 0.0
        sxx=sum(d[0]*d[0] for d in near); syy=sum(d[1]*d[1] for d in near); sxy=sum(d[0]*d[1] for d in near)
        th=0.5*math.atan2(2*sxy, sxx-syy); return math.degrees(th)
    def snap(a):
        m=a%180
        if m<25 or m>155: return 0.0
        if 65<m<115: return 90.0
        return a
    angles=[snap(pca_angle(k)) for k in range(len(chain))]
    # 모듈 사각(w×h)이 잔넬 밖으로 안 나가게 안쪽으로 밀어넣기 — 변/모서리 8점이 모두 모양 안이 되도록.
    offs=[(w/2,0),(-w/2,0),(0,h/2),(0,-h/2),(w/2,h/2),(w/2,-h/2),(-w/2,h/2),(-w/2,-h/2)]
    nudged=[]
    for k,c in enumerate(chain):
        rad=math.radians(angles[k]); ux,uy=math.cos(rad),math.sin(rad); px,py=-uy,ux
        cx,cy=c
        for _ in range(10):
            bad=[(ox,oy) for ox,oy in offs if not pip(polys, cx+ux*ox+px*oy, cy+uy*ox+py*oy)]
            if not bad: break
            mx=sum(b[0] for b in bad)/len(bad); my=sum(b[1] for b in bad)/len(bad)
            cx-=(ux*mx+px*my)*0.35; cy-=(uy*mx+py*my)*0.35
        nudged.append((cx,cy))
    chain=nudged
    placed=len(chain); total=N
    return chain, vertical, placed, total, angles

# =====================================================================
# 렌더
# =====================================================================
def angle_at(chain,k):
    a=chain[max(0,k-1)]; b=chain[min(len(chain)-1,k+1)]
    if a==b: return 0.0
    return math.degrees(math.atan2(b[1]-a[1], b[0]-a[0]))

def draw_letter(ax, polys, spec, exitDir='S'):
    res=place(polys,spec,exitDir)
    chain=res[0]; placed=res[2] if len(res)>2 else len(chain); total=res[3] if len(res)>3 else len(chain)
    angles=res[4] if len(res)>4 else [angle_at(chain,k) for k in range(len(chain))]
    # outline (even-odd: outer + holes)
    for poly in polys:
        xs=[p[0] for p in poly]+[poly[0][0]]; ys=[p[1] for p in poly]+[poly[0][1]]
        ax.plot(xs,ys,'-',color='#2563eb',lw=1.0)
    w=spec['w']; h=spec['h']; bn=spec['bulbs']
    # wires end-to-end
    half=w/2
    def end_toward(c,deg,tx,ty):
        r=math.radians(deg); ux=math.cos(r)*half; uy=math.sin(r)*half
        e1=(c[0]+ux,c[1]+uy); e2=(c[0]-ux,c[1]-uy)
        return e1 if (e1[0]-tx)**2+(e1[1]-ty)**2<=(e2[0]-tx)**2+(e2[1]-ty)**2 else e2
    for k in range(len(chain)-1):
        a=chain[k]; b=chain[k+1]; da=angles[k]; db=angles[k+1]
        ex=end_toward(a,da,b[0],b[1]); en=end_toward(b,db,a[0],a[1])
        ax.plot([ex[0],en[0]],[ex[1],en[1]],'-',color='#e23b3b',lw=1.2,zorder=3)
    # bodies + bulbs
    for k,c in enumerate(chain):
        deg=angles[k]
        tr=mtransforms.Affine2D().rotate_deg_around(c[0],c[1],deg)+ax.transData
        ax.add_patch(Rectangle((c[0]-w/2,c[1]-h/2),w,h,facecolor='#2b3240',edgecolor='#1b2230',lw=0.4,transform=tr,zorder=4))
        for i in range(bn):
            bx=c[0]+((i+1)/(bn+1)-0.5)*w
            ax.add_patch(Circle((bx,c[1]),min(h*0.32,(w/(bn+1))*0.4),facecolor='#ffe45c',edgecolor='#e0a800',lw=0.3,transform=tr,zorder=5))
    # cap + tongue
    if len(chain)>=1:
        a0=chain[0]; a1=chain[1] if len(chain)>1 else (a0[0]-1,a0[1])
        ox,oy=a0[0]-a1[0],a0[1]-a1[1]; ol=math.hypot(ox,oy) or 1; ox/=ol; oy/=ol
        cap=(a0[0]+ox*(w/2+h*0.4),a0[1]+oy*(w/2+h*0.4))
        ax.add_patch(Circle(cap,h*0.5,facecolor='#111',zorder=6))
        z=chain[-1]; y2=chain[-2] if len(chain)>1 else (z[0]+1,z[1])
        ex,ey=z[0]-y2[0],z[1]-y2[1]; el=math.hypot(ex,ey) or 1; ex/=el; ey/=el
        L=wire=spec['wire']*0.4
        for s in (0.42,-0.42):
            px,py=-ey,ex
            tip=(z[0]+ex*(w/2)+ex*L+px*L*s, z[1]+ey*(w/2)+ey*L+py*L*s)
            base=(z[0]+ex*(w/2),z[1]+ey*(w/2))
            ax.plot([base[0],tip[0]],[base[1],tip[1]],'-',color='#e23b3b',lw=1.2,zorder=3)
    minx,miny,maxx,maxy=bbox(polys)
    ax.set_title(f"{spec['name']} · {placed}개"+(f"/{total}" if total!=placed else "")+f" · {'V' if res[1] else 'H'}",fontsize=8)
    ax.set_aspect('equal'); ax.invert_yaxis(); ax.axis('off')

def montage(letters, key, fname, exitDir='S'):
    spec=SPECS[key]
    n=len(letters); cols=4; rows=math.ceil(n/cols)
    fig,axs=plt.subplots(rows,cols,figsize=(cols*3.2,rows*3.0))
    axs=axs.flatten() if n>1 else [axs]
    for i,polys in enumerate(letters): draw_letter(axs[i],polys,spec,exitDir)
    for i in range(n,len(axs)): axs[i].axis('off')
    plt.tight_layout(); plt.savefig(fname,dpi=90); plt.close()
    print('saved',fname)

if __name__=='__main__':
    import sys
    which=sys.argv[1] if len(sys.argv)>1 else 'all'
    if which in ('all','fila'):
        montage(FILA,'g3','scripts/lab_fila_g3.png')
    if which in ('all','under'):
        montage(UNDER,'g3','scripts/lab_under_g3.png')
        montage(UNDER,'m2','scripts/lab_under_m2.png')
        montage(UNDER,'mini3','scripts/lab_under_mini3.png')
        montage(UNDER,'g1','scripts/lab_under_g1.png')
