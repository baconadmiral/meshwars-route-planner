"""Active MeshWars places and conservative, explicitly estimated route bonuses."""
from collections import OrderedDict
from datetime import datetime, timedelta
import json
import math
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


def current_week():
    day=datetime.now(ZoneInfo('America/Denver')).date()
    return (day-timedelta(days=(day.weekday()-2)%7)).isoformat()


def clip_segment(a,b,bounds):
    low,high=0.,1.
    for axis,lower,upper in ((0,bounds['west'],bounds['east']),(1,bounds['south'],bounds['north'])):
        delta=b[axis]-a[axis]
        if not delta:
            if not lower<=a[axis]<=upper:return None
        else:
            first,last=sorted(((lower-a[axis])/delta,(upper-a[axis])/delta))
            low,high=max(low,first),min(high,last)
            if low>high:return None
    return [[a[i]+t*(b[i]-a[i]) for i in (0,1)] for t in (low,high)]


def validate_places(data):
    if not isinstance(data,dict) or data.get('week_start')!=current_week() or not isinstance(data.get('places'),list):
        raise ValueError('Place feed is unavailable or from a different scoring week.')
    boundaries=data.get('park_boundaries',{})
    if not isinstance(boundaries,dict) or boundaries.get('type')!='FeatureCollection':
        raise ValueError('Invalid park boundaries.')
    if len(data['places'])>5000:raise ValueError('Too many places in response.')
    rows={}
    for item in data['places']:
        if not isinstance(item,dict) or type(item.get('id')) is not int or item['id']<0:
            raise ValueError('Invalid place ID.')
        if item.get('type') not in ('summit','park','landmark') or not isinstance(item.get('name'),str):
            raise ValueError('Invalid place type/name.')
        if type(item.get('rotates')) is not bool:
            raise ValueError('Missing weekly rotation status.')
        if any(isinstance(item.get(k),bool) or not isinstance(item.get(k),(int,float)) or not math.isfinite(item[k]) for k in ('lat','lon','points')):
            raise ValueError('Invalid place position or points.')
        if not -90<=item['lat']<=90 or not -180<=item['lon']<=180 or not 0<item['points']<=100:
            raise ValueError('Place outside valid range.')
        if item['id'] in rows:
            raise ValueError('Duplicate place ID.')
        rows[item['id']]={k:item[k] for k in ('id','type','name','lat','lon','points','rotates')}
    features=[]
    features_raw=boundaries.get('features')
    if not isinstance(features_raw,list) or len(features_raw)>500:raise ValueError('Invalid boundary list.')
    for feature in features_raw:
        if not isinstance(feature,dict):raise ValueError('Invalid park feature.')
        props=feature.get('properties',{})
        geometry=feature.get('geometry',{})
        if not isinstance(props,dict) or not isinstance(geometry,dict):raise ValueError('Invalid park metadata.')
        if not isinstance(props.get('name'),str) or isinstance(props.get('points'),bool) or not isinstance(props.get('points'),(int,float)) or not math.isfinite(props['points']) or not 0<props['points']<=100:raise ValueError('Invalid park bonus.')
        if type(props.get('id')) is not int or geometry.get('type') not in ('Polygon','MultiPolygon'):
            raise ValueError('Invalid park geometry.')
        polygons=geometry.get('coordinates') if geometry['type']=='MultiPolygon' else [geometry.get('coordinates')]
        if not isinstance(polygons,list) or not polygons:raise ValueError('Invalid park coordinates.')
        for polygon in polygons:
            if not isinstance(polygon,list) or not polygon:raise ValueError('Empty park geometry.')
            for ring in polygon:
                if not isinstance(ring,list) or len(ring)<4 or ring[0]!=ring[-1]:raise ValueError('Invalid park ring.')
                for point in ring:
                    if not isinstance(point,list) or len(point)<2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point[:2]):raise ValueError('Invalid park vertex.')
                    if not -180<=point[0]<=180 or not -90<=point[1]<=90:raise ValueError('Park vertex out of range.')
        features.append(feature)
    if type(data.get('truncated')) is not bool:raise ValueError('Missing place completeness status.')
    return {'week_start':data['week_start'],'places':list(rows.values()),
            'park_boundaries':{'type':'FeatureCollection','features':features},'truncated':data['truncated']}


class PlacesFeed:
    def __init__(self,url='https://meshwars.com/api/places'):
        self.url=url
        self._lock=threading.Lock()
        self._cache=OrderedDict()

    def load(self,coords,budget_seconds,allowed_bounds=None):
        # An optimistic envelope guides discovery; returned roads still enforce budgets.
        padding=min(.8,max(.025,budget_seconds*13.9/111320/2))
        west,east=min(p[0] for p in coords)-padding,max(p[0] for p in coords)+padding
        south,north=min(p[1] for p in coords)-padding,max(p[1] for p in coords)+padding
        if allowed_bounds:
            points=allowed_bounds['coordinates'][0] if allowed_bounds.get('type')=='Polygon' else [[allowed_bounds['west'],allowed_bounds['south']],[allowed_bounds['east'],allowed_bounds['north']]]
            west=max(west,min(p[0] for p in points)-.02);east=min(east,max(p[0] for p in points)+.02)
            south=max(south,min(p[1] for p in points)-.02);north=min(north,max(p[1] for p in points)+.02)
        bounds={'west':max(-180,math.floor(west*100)/100),'east':min(180,math.ceil(east*100)/100),
                'south':max(-90,math.floor(south*100)/100),'north':min(90,math.ceil(north*100)/100)}
        if bounds['east']-bounds['west']>5 or bounds['north']-bounds['south']>5:
            return {'available':False,'places':[],'week_start':current_week(),'truncated':True,'error':'Trip area is too large for place discovery; using territory only.'}
        key=(current_week(),*bounds.values())
        with self._lock:
            cached=self._cache.get(key)
            if cached and cached[1]['week_start']==current_week() and time.time()-cached[0]<1800:
                self._cache.move_to_end(key)
                return dict(cached[1],available=True,stale=False,last_success=cached[0])
        try:
            params=dict(bounds,zoom=14,board='meshtastic')
            with urlopen(Request(self.url+'?'+urlencode(params),headers={'Accept':'application/json','User-Agent':'MeshWarsRoutePlanner/0.1'}),timeout=15) as response:
                raw=response.read(4*1024*1024+1)
                if len(raw)>4*1024*1024:raise ValueError('Place response exceeds limit.')
                data=validate_places(json.loads(raw))
                data['query_bounds']=bounds
            now=time.time()
            with self._lock:
                self._cache[key]=(now,data)
                self._cache.move_to_end(key)
                while len(self._cache)>8:self._cache.popitem(last=False)
            return dict(data,available=True,stale=False,last_success=now)
        except (OSError,ValueError,TypeError,KeyError):
            if cached:return dict(cached[1],available=True,stale=True,last_success=cached[0],error='Using cached places from this scoring week.')
            return {'available':False,'places':[],'park_boundaries':{'type':'FeatureCollection','features':[]},
                    'week_start':current_week(),'error':'Places unavailable; ranking uses territory only.','stale':True,'truncated':False}


class PlaceScorer:
    def __init__(self,data,remaining=100,excluded=(),weight=1):
        # Lazy import avoids coupling the data adapter to planner initialization.
        from planner import LAT_STEP,LON_STEP,route_grid_cells
        self.data=data
        self.remaining=remaining
        self.weight=weight
        self.excluded=set(excluded)
        self.by_cell={}
        self.rows={p['id']:dict(p) for p in data.get('places',[])}
        self.candidate_cells={}
        self.limited=False
        indexed_count=0
        boundaries={f['properties']['id']:f for f in data.get('park_boundaries',{}).get('features',[])}
        for identity,feature in boundaries.items():
            if identity not in self.rows:
                props=feature['properties']
                # Boundary-only features are always-active parks from the source.
                if not isinstance(props.get('points'),(int,float)) or not 0<props['points']<=100:continue
                ring=feature['geometry']['coordinates']
                point=ring[0][0] if feature['geometry']['type']=='Polygon' else ring[0][0][0]
                self.rows[identity]={'id':identity,'type':'park','name':str(props.get('name','Park')),'points':props['points'],'lat':point[1],'lon':point[0],'rotates':False}
        for identity,place in self.rows.items():
            row,col=math.floor(place['lat']/LAT_STEP),math.floor(place['lon']/LON_STEP)
            cells=set()
            basis=''
            if place['type']=='summit':
                cells={f'{row}_{col}'};basis='peak cell only; surrounding elevation eligibility unavailable'
            elif identity in boundaries:
                geometry=boundaries[identity]['geometry']
                polygons=geometry['coordinates'] if geometry['type']=='MultiPolygon' else [geometry['coordinates']]
                # Conservative perimeter-only estimate; never reward a forest's whole bbox/interior.
                edge_cells=set()
                for polygon in polygons:
                    for ring in polygon:
                        for a,b in zip(ring,ring[1:]):
                            segment=clip_segment(a,b,data['query_bounds']) if data.get('query_bounds') else [a,b]
                            if segment:edge_cells.update(route_grid_cells(segment))
                            if len(edge_cells)>50000:break
                if len(edge_cells)>50000:
                    self.limited=True
                    continue
                for cell in edge_cells:
                    r,c=map(int,cell.split('_'))
                    cells.update(f'{r+dy}_{c+dx}' for dy in (-1,0,1) for dx in (-1,0,1))
                basis='estimated boundary cells plus one grid ring; simplified public outline'
            elif place['type']=='landmark' or place['rotates']:
                cells={f'{row+dy}_{col+dx}' for dy in (-1,0,1) for dx in (-1,0,1)}
                basis='point cell plus eight adjacent cells'
            else:
                basis='park eligibility unavailable without a mapped outline'
                self.limited=True
            if indexed_count+len(cells)>150000:
                cells=set();self.limited=True;basis='eligibility skipped at indexing limit'
            indexed_count+=len(cells)
            place['eligibility_basis']=basis
            self.candidate_cells[identity]=cells
            for cell in cells:self.by_cell.setdefault(cell,[]).append(place)
        for cell,rows in self.by_cell.items():
            rows.sort(key=lambda p:(-p['points'],(p['id']*2654435761)%1000000007))

    def score(self,visited):
        seen=set();places=[]
        for cell in sorted(visited):
            matches=self.by_cell.get(cell)
            if not matches:continue
            winner=matches[0]  # A used higher-value place still suppresses lower-value overlaps.
            identity=winner['id']
            if identity in seen or identity in self.excluded:continue
            seen.add(identity);places.append(dict(winner))
        raw=sum(p['points'] for p in places)
        return {'place_bonus':min(self.remaining,raw),'place_bonus_uncapped':raw,
                'bonus_places':sorted(places,key=lambda p:(-p['points'],p['id'])),
                'place_count':len(places),'place_bonus_estimated':True}

    def proposals(self,start,end,via,visited=(),limit=4,allowed_bounds=None):
        from planner import LAT_STEP,LON_STEP,distance_meters
        from route_bounds import point_inside
        credited={p['id'] for p in self.score(visited)['bonus_places']}
        if self.remaining<=self.score(visited)['place_bonus']:return []
        chain=[start,*via,end]
        ranked=[]
        for identity,cells in self.candidate_cells.items():
            if identity in credited or identity in self.excluded:continue
            place=self.rows[identity]
            best=None
            ordered=sorted(cells)
            sampled=ordered[::max(1,math.ceil(len(ordered)/200))]
            for cell in sampled:
                if self.by_cell[cell][0]['id']!=identity:continue
                r,c=map(int,cell.split('_'));point=[(c+.5)*LON_STEP,(r+.5)*LAT_STEP]
                if not point_inside(point,allowed_bounds):continue
                costs=[distance_meters(a,point)+distance_meters(point,b)-distance_meters(a,b) for a,b in zip(chain,chain[1:])]
                i=min(range(len(costs)),key=costs.__getitem__)
                candidate=(costs[i],r,c,i,point)
                if best is None or candidate[:4]<best[:4]:best=candidate
            if best:
                cost,r,c,i,point=best
                ranked.append(((cost+400)/min(place['points'],self.remaining),identity,i,point))
        proposals=[]
        for _,identity,i,point in sorted(ranked):
            candidate=via[:i]+[point]+via[i:]
            if candidate not in proposals:proposals.append(candidate)
            if len(proposals)>=limit:break
        return proposals


def place_options(value=None):
    if value is None:value={}
    if not isinstance(value,dict):raise ValueError('Invalid place bonus settings.')
    options={'enabled':value.get('enabled',True),'weight':value.get('weight',1),
             'remaining':value.get('remaining',100),'excluded':value.get('excluded',[]),'week':value.get('week')}
    if type(options['enabled']) is not bool:raise ValueError('Invalid bonus toggle.')
    for key,maximum in (('weight',5),('remaining',100)):
        v=options[key]
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not 0<=v<=maximum:
            raise ValueError(f'Place {key} must be between 0 and {maximum}.')
    if not isinstance(options['excluded'],list) or len(options['excluded'])>500 or any(type(v) is not int or v<0 for v in options['excluded']):
        raise ValueError('Provide at most 500 already-visited place IDs.')
    if options['week'] is not None:
        try:
            day=datetime.strptime(options['week'],'%Y-%m-%d').date()
            if day.weekday()!=2:raise ValueError('Not a Wednesday.')
        except (ValueError,TypeError):raise ValueError('Invalid scoring week.')
    options['excluded']=sorted(set(options['excluded']))
    return options
