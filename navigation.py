"""Portable navigation handoff and lossless GPX track export."""
from teams import validate_team
import math
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

GPX_NS='http://www.topografix.com/GPX/1/1'
ET.register_namespace('',GPX_NS)


def coordinate(value):
    if not isinstance(value,(list,tuple)) or len(value)<2:
        raise ValueError('Expected [longitude, latitude] coordinates.')
    lon,lat=value[:2]
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (lon,lat)):
        raise ValueError('Coordinates must be finite numbers.')
    if not -180<=lon<=180 or not -90<=lat<=90:
        raise ValueError('Coordinates out of range.')
    return [lon,lat]


def format_location(point):
    return f'{point[1]:.6f},{point[0]:.6f}'


def build_export(route):
    if not isinstance(route,dict):
        raise ValueError('Expected a route object.')
    team=validate_team(route.get('team','BLUE'))
    geometry=route.get('geometry')
    if not isinstance(geometry,dict) or geometry.get('type','LineString')!='LineString':
        raise ValueError('Expected a LineString route.')
    raw=geometry.get('coordinates')
    if not isinstance(raw,list) or not 2<=len(raw)<=100000:
        raise ValueError('Route must contain 2–100,000 track points.')
    coords=[coordinate(p) for p in raw]
    via=route.get('via_points',[])
    if not isinstance(via,list) or len(via)>32:
        raise ValueError('Expected at most 32 intermediate stops.')
    via=[coordinate(p) for p in via]
    points=[coords[0],*via,coords[-1]]
    raw_labels=route.get('stop_labels',[])
    if not isinstance(raw_labels,list):
        raise ValueError('Invalid stop labels.')
    labels=['A']+[str(raw_labels[i])[:80] if i<len(raw_labels) else f'Detour {i+1}' for i in range(len(via))]+['B']
    sections=[]
    for start in range(0,len(points)-1,4):
        end=min(start+4,len(points)-1)
        stops=points[start:end+1]
        params={'api':'1','origin':format_location(stops[0]),'destination':format_location(stops[-1]),
                'travelmode':'driving','dir_action':'navigate'}
        if len(stops)>2:
            params['waypoints']='|'.join(format_location(p) for p in stops[1:-1])
        url='https://www.google.com/maps/dir/?'+urlencode(params)
        if len(url)>2048:
            raise ValueError('Navigation link exceeds Google Maps URL limit.')
        sections.append({'url':url,'from_label':labels[start],'to_label':labels[end],
                         'stops':stops,'labels':labels[start:end+1]})
    root=ET.Element(f'{{{GPX_NS}}}gpx',{'version':'1.1','creator':f'MeshWars {team} Route Planner'})
    for point,label in zip(points,labels):
        waypoint=ET.SubElement(root,f'{{{GPX_NS}}}wpt',{'lat':str(point[1]),'lon':str(point[0])})
        ET.SubElement(waypoint,f'{{{GPX_NS}}}name').text=label
    track=ET.SubElement(root,f'{{{GPX_NS}}}trk')
    ET.SubElement(track,f'{{{GPX_NS}}}name').text=f'MeshWars {team} planned route'
    ET.SubElement(track,f'{{{GPX_NS}}}desc').text='Imported track of the planned road geometry. Turn-by-turn instructions are not embedded.'
    segment=ET.SubElement(track,f'{{{GPX_NS}}}trkseg')
    for lon,lat in coords:
        ET.SubElement(segment,f'{{{GPX_NS}}}trkpt',{'lat':str(lat),'lon':str(lon)})
    gpx=ET.tostring(root,encoding='utf-8',xml_declaration=True).decode()
    return {'sections':sections,'gpx':gpx,'trackpoint_count':len(coords),'stop_count':len(points)}
