"""The Goal Tool's ball (icons/soccer-logo.svg and the topbar mark in soccer/index.html).

    python3 scripts/soccer-ball.py > /tmp/ball.svg        # the topbar <svg class="brand-puck">

A truncated icosahedron on a sphere, centred on a hexagon like Ron's drawing:
green seams, solid green pentagons with a white gap round them, a green rim.
Projected equidistant (radius = angle from the centre / 72 deg), not
orthographic: a true projection squeezes the rim faces into slivers, Ron's
drawing is flatter. Args (all optional): spin tilt pentagon-shrink max-angle.
For the icons/ copy, swap the <svg class=...> tag for an xmlns one, then run
scripts/make-soccer-icons.sh.
"""
import numpy as np, itertools, math, sys
phi=(1+5**.5)/2
V=[]
for a,b in itertools.product([-1,1],[-1,1]):
    V+= [(0,a,b*phi),(a,b*phi,0),(a*phi,0,b)]
V=np.array([v/np.linalg.norm(v) for v in np.array(V,float)])
E=set()
for i in range(12):
    for j in range(i+1,12):
        if abs(np.dot(V[i],V[j])-1/5**.5)<1e-6: E.add((i,j))
nb={i:[j for (a,b) in E for j in (a,b) if i in (a,b) and j!=i] for i in range(12)}
F=[f for f in itertools.combinations(range(12),3) if all(tuple(sorted(p)) in E for p in itertools.combinations(f,2))]
P=lambda a,b,t: V[a]*(1-t)+V[b]*t
def order(pts,c):
    c=c/np.linalg.norm(c); u=np.cross(c,[0.3,0.5,0.8]); u/=np.linalg.norm(u); w=np.cross(c,u)
    return sorted(pts,key=lambda p: math.atan2(np.dot(p,w),np.dot(p,u)))
pents=[order([P(i,j,1/3) for j in nb[i]],V[i]) for i in range(12)]
hexes=[order([P(a,b,t) for (a,b) in itertools.permutations(f,2) for t in [1/3]],sum(V[list(f)])) for f in F]
# rotate: a hexagon centre to +z
c=sum(V[list(F[0])]); c/=np.linalg.norm(c)
def rot_to_z(c):
    z=np.array([0,0,1.]); v=np.cross(c,z); s=np.linalg.norm(v); cc=np.dot(c,z)
    if s<1e-9: return np.eye(3)
    vx=np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]])
    return np.eye(3)+vx+vx@vx*((1-cc)/s**2)
R=rot_to_z(c)
spin=float(sys.argv[1]) if len(sys.argv)>1 else 75
tilt=float(sys.argv[2]) if len(sys.argv)>2 else 0
t=math.radians(spin); Rz=np.array([[math.cos(t),-math.sin(t),0],[math.sin(t),math.cos(t),0],[0,0,1]])
a=math.radians(tilt); Rx=np.array([[1,0,0],[0,math.cos(a),-math.sin(a)],[0,math.sin(a),math.cos(a)]])
M=Rx@Rz@R
CX=CY=32; RAD=27.2
def slerp(p,q,n=10):
    p=p/np.linalg.norm(p); q=q/np.linalg.norm(q); out=[]
    for k in range(n):
        tt=k/n; v=p*(1-tt)+q*tt; out.append(v/np.linalg.norm(v))
    return out
TMAX=math.radians(float(sys.argv[4]) if len(sys.argv)>4 else 72)
def theta(v): return math.acos(max(-1,min(1,(M@v)[2]/np.linalg.norm(v))))
def proj(v):
    v=M@v; v=v/np.linalg.norm(v)
    th=math.acos(max(-1,min(1,v[2]))); n=np.linalg.norm(v[:2])
    d=v[:2]/n if n>1e-9 else np.zeros(2)
    r=th/TMAX
    return (CX+d[0]*r*RAD, CY-d[1]*r*RAD)
def path(poly):
    pts=[]
    for k in range(len(poly)): pts+=slerp(poly[k],poly[(k+1)%len(poly)])
    if min(theta(p) for p in pts)>TMAX: return None
    if max(theta(p) for p in pts)>math.radians(150): return None
    q=[proj(p) for p in pts]
    return 'M'+'L'.join(f'{x:.1f} {y:.1f}' for x,y in q)+'Z'
def shrink(poly,s):
    c=sum(poly)/len(poly); return [c+(p-c)*s for p in poly]
pent_d=[path(shrink(p,SHR)) for p in pents] if (SHR:=float(sys.argv[3]) if len(sys.argv)>3 else 0.76) else []
pent_d=[d for d in pent_d if d]
# seams: every edge of the truncated icosahedron, visible half only
edges=set()
for poly in pents+hexes:
    for k in range(len(poly)):
        a_,b_=poly[k],poly[(k+1)%len(poly)]
        key=tuple(sorted([tuple(np.round(a_,5)),tuple(np.round(b_,5))]))
        edges.add(key)
seg=[]
for a_,b_ in edges:
    pts=slerp(np.array(a_),np.array(b_),12)+[np.array(b_)/np.linalg.norm(b_)]
    run=[]
    for p in pts:
        if theta(p)<=TMAX+math.radians(25): run.append(proj(p))
        else:
            if len(run)>1: seg.append(run)
            run=[]
    if len(run)>1: seg.append(run)
seam_d=''.join('M'+'L'.join(f'{x:.1f} {y:.1f}' for x,y in r) for r in seg)
G='#66bc07'
svg=f'''<svg class="brand-puck" viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id="brand-ball-clip"><circle cx="32" cy="32" r="{RAD}"/></clipPath></defs><circle cx="32" cy="32" r="{RAD}" fill="#ffffff"/><g clip-path="url(#brand-ball-clip)"><path d="{''.join(pent_d)}" fill="{G}"/><path d="{seam_d}" fill="none" stroke="{G}" stroke-width="1.8" stroke-linejoin="round"/></g><circle cx="32" cy="32" r="{RAD+1.1}" fill="none" stroke="{G}" stroke-width="2.6"/></svg>'''
print(svg)
