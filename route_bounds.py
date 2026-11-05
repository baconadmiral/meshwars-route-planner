"""Optional WGS84 box or polygon route constraint, independent of coverage estimates."""
import math


def validate_bounds(bounds):
    if bounds is None:
        return None
    if isinstance(bounds, dict) and bounds.get('type') == 'Polygon':
        return validate_polygon(bounds)
    if not isinstance(bounds, dict) or set(bounds) != {'west', 'south', 'east', 'north'}:
        raise ValueError('Route area needs west, south, east, and north bounds.')
    values = [bounds[key] for key in ('west', 'south', 'east', 'north')]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise ValueError('Route area bounds must be finite numbers.')
    west, south, east, north = values
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError('Draw a non-empty route area that does not cross the date line.')
    return dict(bounds)


def point_inside(point, bounds):
    if bounds is not None and bounds.get('type') == 'Polygon':
        return polygon_contains(point, bounds['coordinates'][0])
    return bounds is None or (bounds['west'] <= point[0] <= bounds['east'] and
                              bounds['south'] <= point[1] <= bounds['north'])


def cross(a, b):
    return a[0]*b[1]-a[1]*b[0]


def segment_cuts(a, b, c, d):
    """Parameters where a road segment meets a polygon edge, including overlap."""
    r=[b[i]-a[i] for i in (0,1)]
    s=[d[i]-c[i] for i in (0,1)]
    q=[c[i]-a[i] for i in (0,1)]
    denominator=cross(r,s)
    if abs(denominator)>1e-18:
        t,u=cross(q,s)/denominator,cross(q,r)/denominator
        return [max(0.,min(1.,t))] if -1e-12<=t<=1+1e-12 and -1e-12<=u<=1+1e-12 else []
    if abs(cross(q,r))>1e-18:
        return []
    length=r[0]*r[0]+r[1]*r[1]
    if not length:
        return [0.] if on_edge(a,c,d) else []
    low,high=sorted(sum((p[i]-a[i])*r[i] for i in (0,1))/length for p in (c,d))
    if high<0 or low>1:
        return []
    return [max(0.,low),min(1.,high)]


def on_edge(p,a,b):
    return (abs(cross([p[0]-a[0],p[1]-a[1]],[b[0]-a[0],b[1]-a[1]]))<=1e-18 and
            min(a[0],b[0])-1e-12<=p[0]<=max(a[0],b[0])+1e-12 and
            min(a[1],b[1])-1e-12<=p[1]<=max(a[1],b[1])+1e-12)


def polygon_contains(point, ring):
    x,y=point
    inside=False
    for a,b in zip(ring,ring[1:]):
        if on_edge(point,a,b):
            return True
        if (a[1]>y)!=(b[1]>y) and x < a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]):
            inside=not inside
    return inside


def validate_polygon(bounds):
    rings=bounds.get('coordinates')
    if set(bounds)!={'type','coordinates'} or not isinstance(rings,list) or len(rings)!=1 or not isinstance(rings[0],list):
        raise ValueError('Draw one polygon without holes.')
    ring=rings[0]
    if not 4<=len(ring)<=101:
        raise ValueError('A polygon needs 3–100 corners and a closed ring.')
    for point in ring:
        if not isinstance(point,list) or len(point)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point):
            raise ValueError('Polygon corners must be finite longitude/latitude pairs.')
        if not -180<=point[0]<=180 or not -90<=point[1]<=90:
            raise ValueError('Polygon corner outside the world map.')
    if ring[0]!=ring[-1] or len({tuple(p) for p in ring[:-1]})!=len(ring)-1:
        raise ValueError('Close the polygon without repeated corners.')
    if max(p[0] for p in ring)-min(p[0] for p in ring)>180:
        raise ValueError('Polygons cannot cross the date line.')
    # Shift coordinates before the area calculation to avoid cancellation.
    origin=ring[0]
    shifted=[[p[i]-origin[i] for i in (0,1)] for p in ring]
    if abs(sum(cross(a,b) for a,b in zip(shifted,shifted[1:])))<1e-16:
        raise ValueError('Draw a polygon with a non-zero area.')
    edges=list(zip(ring,ring[1:]))
    for i,(a,b) in enumerate(edges):
        for j,(c,d) in enumerate(edges[i+1:],i+1):
            if j==i+1 or (i==0 and j==len(edges)-1):
                continue
            if segment_cuts(a,b,c,d):
                raise ValueError('Polygon edges cannot cross or touch each other.')
        # Adjacent edges may share only their common corner, not backtrack.
        c=ring[(i+2)%(len(ring)-1)]
        if on_edge(c,a,b) or on_edge(a,b,c):
            raise ValueError('Polygon edges cannot overlap.')
    return {'type':'Polygon','coordinates':[[list(p) for p in ring]]}


def route_inside(route, bounds):
    coords=route['geometry']['coordinates']
    if bounds is None:
        return True
    if not all(point_inside(p,bounds) for p in coords):
        return False
    if bounds.get('type')!='Polygon':
        return True  # Rectangles are convex.
    ring=bounds['coordinates'][0]
    for a,b in zip(coords,coords[1:]):
        cuts={0.,1.}
        for c,d in zip(ring,ring[1:]):
            cuts.update(segment_cuts(a,b,c,d))
        ordered=sorted(cuts)
        for left,right in zip(ordered,ordered[1:]):
            t=(left+right)/2
            if not polygon_contains([a[i]+t*(b[i]-a[i]) for i in (0,1)],ring):
                return False
    return True


class StopsOutsideArea(ValueError):
    def __init__(self, keys, labels):
        self.stop_keys=keys
        super().__init__(f'{", ".join(labels)} must be inside the route area. Move the stops or redraw/clear the area.')


def validate_stops(start, end, waypoints, bounds):
    stops=[('start','Start (A)',start),*[(f'W{i+1}',f'Waypoint W{i+1}',p) for i,p in enumerate(waypoints)],('end','Destination (B)',end)]
    outside=[(key,label) for key,label,point in stops if not point_inside(point,bounds)]
    if outside:
        raise StopsOutsideArea([key for key,_ in outside],[label for _,label in outside])
