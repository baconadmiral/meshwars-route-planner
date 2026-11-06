"""User-marked road corridors: geometry checks and bounded baseline bypass probes."""
import math

from route_bounds import point_inside, route_inside


def validate_blocked_roads(value=None):
    if value is None:return []
    if not isinstance(value,list) or len(value)>10:
        raise ValueError('Mark at most 10 blocked road sections.')
    result=[]
    for road in value:
        if not isinstance(road,dict):raise ValueError('Invalid blocked road section.')
        coords=road.get('coordinates')
        width=road.get('buffer_meters',20)
        if isinstance(width,bool) or not isinstance(width,(int,float)) or not math.isfinite(width) or not 5<=width<=100:
            raise ValueError('Blocked-road buffer must be between 5 and 100 meters.')
        if not isinstance(coords,list) or not 2<=len(coords)<=20:
            raise ValueError('Each blocked road needs 2 to 20 points.')
        points=[]
        for p in coords:
            if (not isinstance(p,list) or len(p)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in p)
                    or not -180<=p[0]<=180 or not -85<=p[1]<=85):
                raise ValueError('Invalid blocked-road coordinates.')
            points.append(list(p))
        if all(p==points[0] for p in points):raise ValueError('Mark a section of road, not a single point.')
        if max(p[0] for p in points)-min(p[0] for p in points)>2 or max(p[1] for p in points)-min(p[1] for p in points)>2:
            raise ValueError('Mark a shorter blocked road section.')
        result.append({'coordinates':points,'buffer_meters':float(width)})
    return result


def point_segment_distance(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1]
    length=dx*dx+dy*dy
    t=max(0.,min(1.,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0.
    return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)


def segment_distance(a,b,c,d):
    def cross(p,q,r):return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    ab_c,ab_d,cd_a,cd_b=cross(a,b,c),cross(a,b,d),cross(c,d,a),cross(c,d,b)
    if ((ab_c>0 and ab_d<0 or ab_c<0 and ab_d>0)
            and (cd_a>0 and cd_b<0 or cd_a<0 and cd_b>0)):
        return 0.
    return min(point_segment_distance(a,c,d),point_segment_distance(b,c,d),
               point_segment_distance(c,a,b),point_segment_distance(d,a,b))


def hits_road(coords,road):
    points=road['coordinates'];buffer=road['buffer_meters']
    scale=max(.1,math.cos(math.radians(sum(p[1] for p in points)/len(points))))
    origin=points[0]
    def project(p):return [(p[0]-origin[0])*111320*scale,(p[1]-origin[1])*111320]
    marked=[project(p) for p in points]
    west,east=min(p[0] for p in marked)-buffer,max(p[0] for p in marked)+buffer
    south,north=min(p[1] for p in marked)-buffer,max(p[1] for p in marked)+buffer
    projected=[project(p) for p in coords]
    if len(projected)==1:projected=projected*2
    for a,b in zip(projected,projected[1:]):
        if max(a[0],b[0])<west or min(a[0],b[0])>east or max(a[1],b[1])<south or min(a[1],b[1])>north:continue
        if any(segment_distance(a,b,c,d)<=buffer for c,d in zip(marked,marked[1:])):return True
    return False


def route_blocked(route,roads):
    return any(hits_road(route['geometry']['coordinates'],road) for road in roads)


def validate_blocked_stops(start,end,waypoints,roads):
    for label,point in [('Start (A)',start),*[(f'Waypoint W{i+1}',p) for i,p in enumerate(waypoints)],('Destination (B)',end)]:
        for i,road in enumerate(roads):
            if hits_road([point],road):
                raise ValueError(f'{label} is on blocked road {i+1}. Move the stop or adjust the blocked section.')


def bypass_proposals(points,road,bounds=None):
    coords=road['coordinates']
    center=[sum(p[i] for p in coords)/len(coords) for i in (0,1)]
    scale=max(.1,math.cos(math.radians(center[1])))
    def dist(a,b):return math.hypot((a[0]-b[0])*scale,a[1]-b[1])
    leg=min(range(len(points)-1),key=lambda i:dist(points[i],center)+dist(center,points[i+1])-dist(points[i],points[i+1]))
    for margin in (60,200,600):
        meters=margin+road['buffer_meters']
        west,east=min(p[0] for p in coords)-meters/(111320*scale),max(p[0] for p in coords)+meters/(111320*scale)
        south,north=min(p[1] for p in coords)-meters/111320,max(p[1] for p in coords)+meters/111320
        for pair in ([[west,south],[east,south]],[[west,north],[east,north]],[[west,south],[west,north]],[[east,south],[east,north]]):
            if dist(points[leg],pair[1])<dist(points[leg],pair[0]):pair=list(reversed(pair))
            proposal=points[:leg+1]+pair+points[leg+1:]
            if all(-180<=p[0]<=180 and -85<=p[1]<=85 and point_inside(p,bounds) for p in proposal):yield proposal


def find_bypass_routes(points,rejected,roads,router,bounds=None,limit=12,progress=None):
    """Try at most twelve requests; subsequent closures can extend a failed probe."""
    work=[]
    seen=set()
    def add_proposals(chain,route):
        blocked=next((road for road in roads if hits_road(route['geometry']['coordinates'],road)),None)
        if blocked:
            for proposal in bypass_proposals(chain,blocked,bounds):
                key=tuple(tuple(p) for p in proposal)
                if key not in seen:seen.add(key);work.append(proposal)
    for route in rejected:add_proposals(points,route)
    feasible=[]
    count=0
    while work and count<limit:
        chain=work.pop(0);count+=1
        if progress:progress(count,limit)
        try:routes=router(chain,False)
        except (ValueError,OSError):continue
        for route in routes:
            if not route_inside(route,bounds):continue
            if not route_blocked(route,roads):feasible.append(dict(route,_avoidance_via=chain[1:-1]))
            elif count<=8:
                # Prefer addressing a second closure to spending all probes at one radius.
                old_length=len(work);add_proposals(chain,route)
                if len(work)>old_length:work=work[old_length:old_length+4]+work[:old_length]+work[old_length+4:]
    return feasible
