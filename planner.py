"""Deterministic team opportunity scoring and bounded candidate search."""
from teams import validate_team
import math
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed, Future


def intersects(a, b, cell):
    """Clip a longitude/latitude segment to an authoritative cell rectangle."""
    lo, hi = 0.0, 1.0
    for axis, lower, upper in ((0, cell['west'], cell['east']), (1, cell['south'], cell['north'])):
        delta = b[axis] - a[axis]
        if delta == 0:
            if not lower <= a[axis] <= upper:
                return False
        else:
            t1, t2 = (lower-a[axis])/delta, (upper-a[axis])/delta
            lo, hi = max(lo, min(t1, t2)), min(hi, max(t1, t2))
            if lo > hi:
                return False
    return True


def score(route, cells, team='BLUE'):
    coords = route['geometry']['coordinates']
    west, east = min(p[0] for p in coords), max(p[0] for p in coords)
    south, north = min(p[1] for p in coords), max(p[1] for p in coords)
    crossed = {}
    for cell in cells:
        if cell['east'] < west or cell['west'] > east or cell['north'] < south or cell['south'] > north:
            continue
        if any(intersects(a, b, cell) for a, b in zip(coords, coords[1:])):
            crossed[cell['cell_id']] = cell
    targets = [c for c in crossed.values() if c['owner_team'] != team]
    return dict(route, square_count=len(crossed), target_count=len(targets),
                target_ids=[c['cell_id'] for c in targets])


def candidate_points(start, end, cells, limit=8, team='BLUE'):
    """Choose spatially separated opposing targets near the trip corridor."""
    sx, sy = start
    ex, ey = end
    scale = max(.1, math.cos(math.radians((sy+ey)/2)))
    ranked = []
    direct = math.hypot((ex-sx)*scale, ey-sy)
    for c in cells:
        if target_value(c, team=team) == 0:
            continue
        x, y = (c['west']+c['east'])/2, (c['south']+c['north'])/2
        distance = math.hypot((x-sx)*scale, y-sy) + math.hypot((ex-x)*scale, ey-y)
        if distance <= direct + .08:
            ranked.append((distance/max(.0001,target_value(c, team=team)), x, y))
    selected = []
    for _, x, y in sorted(ranked):
        if all(math.hypot((x-p[0])*scale, y-p[1]) > .008 for p in selected):
            selected.append([x, y])
        if len(selected) == limit:
            break
    return selected


def choose(routes, cells, budget_seconds, baseline_seconds, team='BLUE'):
    feasible = [score(r, cells, team=team) for r in routes if r['duration'] <= baseline_seconds + budget_seconds + 1e-6]
    return sorted(feasible, key=lambda r: (-r['target_count'], r['duration'], r['distance']))


LAT_STEP = .0027
LON_STEP = .00384


def route_grid_cells(coords):
    """Enumerate cells traversed through their interiors, including unmapped cells."""
    visited = set()
    for a, b in zip(coords, coords[1:]):
        cuts = {0., 1.}
        for axis, step in ((0, LON_STEP), (1, LAT_STEP)):
            low, high = sorted((a[axis], b[axis]))
            if high == low:
                continue
            for edge in range(math.floor(low/step)+1, math.ceil(high/step)):
                cuts.add((edge*step-a[axis])/(b[axis]-a[axis]))
        ordered = sorted(cuts)
        for left, right in zip(ordered, ordered[1:]):
            t = (left+right)/2
            x, y = (a[i]+(b[i]-a[i])*t for i in (0, 1))
            visited.add(f'{math.floor(y/LAT_STEP)}_{math.floor(x/LON_STEP)}')
    return visited


def owner_score(cell):
    """Read the holding team's score; absent/invalid scores remain unknown."""
    if not cell:
        return None
    scores=cell.get('scores')
    value=scores.get(cell.get('owner_team')) if isinstance(scores,dict) else None
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
        return None
    return float(value)


def target_value(cell, team='BLUE'):
    """Heuristic utility, not a probability: sharply discount defended territory."""
    if cell is None:
        return 1.  # Unpainted exploration; coverage remains unverified.
    if cell.get('owner_team')==team:
        return 0.
    points=owner_score(cell)
    if points is None:
        return .5
    return 1. if points<=1 else (1./points)**2


def opportunity_score(route, cells, team='BLUE'):
    known = {c['cell_id']: c for c in cells}
    visited = route_grid_cells(route['geometry']['coordinates'])
    enemy = sorted(k for k in visited if k in known and known[k]['owner_team'] != team)
    unmapped = sorted(visited-known.keys())
    easy=sum(owner_score(known[k]) is not None and owner_score(known[k])<=1 for k in enemy)
    hard=sum(owner_score(known[k]) is not None and owner_score(known[k])>1 for k in enemy)
    value=sum(target_value(known[k], team=team) for k in enemy)+len(unmapped)
    return dict(route, square_count=len(visited), target_count=len(enemy)+len(unmapped),
                target_ids=enemy+unmapped, enemy_count=len(enemy), unmapped_count=len(unmapped),
                capture_value=value,easy_enemy_count=easy,hard_enemy_count=hard,
                unknown_score_count=len(enemy)-easy-hard)


def exploration_points(start, end, cells, budget_seconds, limit=12, team='BLUE'):
    """Explore both sides of the trip at multiple budget-dependent distances."""
    known = {c['cell_id']: c for c in cells}
    scale = max(.1, math.cos(math.radians((start[1]+end[1])/2)))
    center = [(start[i]+end[i])/2 for i in (0, 1)]
    direct = math.hypot((end[0]-start[0])*scale, end[1]-start[1])
    # Optimistic distance envelope, then actual routed durations enforce the budget.
    extra = budget_seconds*13.9/111320
    candidates = []
    for fraction in (.25, .5, 1.):
        radius = max(.004, extra*fraction/2)
        for along in (start, center, end):
            for angle in range(0, 360, 30):
                radians = math.radians(angle)
                x = along[0]+radius*math.cos(radians)/scale
                y = along[1]+radius*math.sin(radians)
                if abs(x)>180 or abs(y)>85:
                    continue
                travel = math.hypot((x-start[0])*scale,y-start[1])+math.hypot((x-end[0])*scale,y-end[1])
                if travel > direct+extra:
                    continue
                row, col = math.floor(y/LAT_STEP), math.floor(x/LON_STEP)
                potential = sum(target_value(known.get(f'{row+dy}_{col+dx}'), team=team)
                                for dy in range(-2,3) for dx in range(-2,3))
                if potential:
                    candidates.append((potential, fraction, x, y))
    # Reserve requests for near, medium, and far excursions so an optimistic
    # outer envelope cannot consume the whole search budget.
    selected = []
    per_band = max(1, limit//3)
    for band in (.25, .5, 1.):
        added = 0
        for potential, fraction, x, y in sorted(candidates, reverse=True):
            if fraction != band:
                continue
            if all(math.hypot((x-p[0])*scale,y-p[1]) > max(.004, extra/12) for p in selected):
                selected.append([x,y])
                added += 1
            if added >= per_band:
                break
    # Include concrete enemy targets as well as unpainted exploration.
    return selected + candidate_points(start,end,cells,limit=4, team=team)


def distance_meters(a, b):
    scale = max(.1, math.cos(math.radians((a[1]+b[1])/2)))
    return 111320*math.hypot((b[0]-a[0])*scale,b[1]-a[1])


def route_anchors(coords):
    """Sample along road segments, including long straight sections between vertices."""
    lengths=[distance_meters(a,b) for a,b in zip(coords,coords[1:])]
    spacing=max(120.,sum(lengths)/100)
    anchors=[coords[0]]
    covered=0.
    next_distance=spacing
    for a,b,length in zip(coords,coords[1:],lengths):
        if length:
            while next_distance<covered+length:
                t=(next_distance-covered)/length
                anchors.append([a[i]+t*(b[i]-a[i]) for i in (0,1)])
                next_distance+=spacing
        covered+=length
    anchors.append(coords[-1])
    return anchors


def insertion_proposals(start, end, route, via, cells, limit=4, team='BLUE'):
    """Find missed targets near the actual road geometry and insert in trip order."""
    known = {c['cell_id']:c for c in cells}
    coords = route['geometry']['coordinates']
    visited = route_grid_cells(coords)
    # Bound CPU work on long trips while retaining points from the entire route.
    anchors = route_anchors(coords)
    candidates = set()
    for x,y in anchors:
        row,col = math.floor(y/LAT_STEP),math.floor(x/LON_STEP)
        for dy in range(-2,3):
            for dx in range(-2,3):
                cell_id=f'{row+dy}_{col+dx}'
                if cell_id not in visited and known.get(cell_id,{}).get('owner_team') != team:
                    candidates.add((row+dy,col+dx))
    chain = [start,*via,end]
    ranked = []
    for row,col in candidates:
        point=[(col+.5)*LON_STEP,(row+.5)*LAT_STEP]
        if abs(point[0])>180 or abs(point[1])>85:
            continue
        costs=[distance_meters(a,point)+distance_meters(point,b)-distance_meters(a,b)
               for a,b in zip(chain,chain[1:])]
        index=min(range(len(costs)),key=costs.__getitem__)
        nearby_gain=sum(target_value(known.get(f'{row+dy}_{col+dx}'), team=team)
                        for dy in range(-1,2) for dx in range(-1,2)
                        if f'{row+dy}_{col+dx}' not in visited)
        proximity=min(distance_meters(point,a) for a in anchors)
        # Favor inexpensive side trips into clusters of missed squares.
        priority=(costs[index]+proximity)/max(.0001,nearby_gain*target_value(known.get(f'{row}_{col}'), team=team))
        ranked.append((priority,row,col,index,point))
    proposals=[]
    selected=[]
    for _,row,col,index,point in sorted(ranked):
        if any(max(abs(row-r),abs(col-c))<2 for r,c in selected):
            continue
        selected.append((row,col))
        proposals.append(via[:index]+[point]+via[index:])
        if len(proposals)>=limit:
            break
    return proposals


def route_rank(route):
    return (-route.get('capture_value',route['target_count']),-route['target_count'],route['duration'],route['distance'])


def distinct_states(states, limit):
    """Keep different road geometries, preserving the best duration for duplicates."""
    selected=[]
    seen=set()
    for state in sorted(states,key=lambda pair:route_rank(pair[0])):
        key=str(state[0]['geometry']['coordinates'])
        if key not in seen:
            seen.add(key)
            selected.append(state)
        if len(selected)>=limit:
            break
    return selected


def diverse_states(states, limit, minimum_difference=0.):
    """Balance capture value with new territory, always retaining the best route.

    Difference is Jaccard distance over all crossed grid cells, including friendly territory.
    The frontier uses a soft preference; final options require 20% difference.
    """
    ranked=distinct_states(states,len(states)+1)
    if not ranked or limit<=0:
        return []
    footprints=[route_grid_cells(route['geometry']['coordinates']) for route,_ in ranked]
    selected=[0]
    remaining=list(range(1,len(ranked)))
    best_value=max(1.,ranked[0][0].get('capture_value',ranked[0][0]['target_count']))
    while remaining and len(selected)<limit:
        candidates=[]
        for index in remaining:
            difference=min(len(footprints[index]^footprints[other])/max(1,len(footprints[index]|footprints[other]))
                           for other in selected)
            if difference+1e-9<minimum_difference:
                continue
            route=ranked[index][0]
            quality=route.get('capture_value',route['target_count'])/best_value
            candidates.append((.65*quality+.35*difference,-index,index))
        if not candidates:
            break
        chosen=max(candidates)[2]
        selected.append(chosen)
        remaining.remove(chosen)
    # Preserve familiar value/duration ordering after selecting the alternatives.
    return [ranked[index] for index in sorted(selected)]


def routing_batch(jobs, router, workers, progress):
    """Run independent requests concurrently, but return results in input order."""
    if not jobs:
        return []
    executor=ThreadPoolExecutor(max_workers=workers,thread_name_prefix='route')
    futures={}
    outcomes=[None]*len(jobs)
    try:
        for index,waypoints in enumerate(jobs):
            futures[executor.submit(router,waypoints)]=index
        completed=0
        for future in as_completed(futures):
            index=futures[future]
            try:
                outcomes[index]=(future.result(),None)
            except (ValueError,OSError) as error:
                outcomes[index]=(None,error)
            completed+=1
            progress(completed,len(jobs))
        return outcomes
    finally:
        # Abort queued requests promptly if the progress callback reports disconnect.
        executor.shutdown(wait=False,cancel_futures=True)


def refine_routes(start, end, cells, seeds, cap, router, strategy, report, workers=4, team='BLUE'):
    """Greedy keeps one incumbent; beam advances six distinct partial routes."""
    width=6 if strategy=='beam' else 1
    maximum=3*4*width
    all_states=list(seeds)
    frontier=diverse_states(seeds,width) if strategy=='beam' else distinct_states(seeds,width)
    seen_jobs=set()
    completed=failures=0
    for depth in range(3):
        children=[]
        old_best=min((route_rank(r) for r,_ in all_states),default=None)
        jobs=[]
        for parent,via in frontier:
            for waypoints in insertion_proposals(start,end,parent,via,cells,limit=4, team=team):
                key=tuple(tuple(p) for p in waypoints)
                if key not in seen_jobs:
                    seen_jobs.add(key)
                    jobs.append(waypoints)
        report(completed/maximum,
               f'{strategy.title()}: checking extended routes, round {depth+1}/3 ({min(workers,len(jobs))} workers)…')
        offset=completed
        def batch_progress(done,total):
            report((offset+done)/maximum,
                   f'{strategy.title()}: {offset+done}/{maximum} refinement checks completed; round {depth+1}/3.')
        outcomes=routing_batch([[start,*via,end] for via in jobs],router,workers,batch_progress)
        for waypoints,(routes,error) in zip(jobs,outcomes):
            if error:
                failures+=1
            else:
                for candidate in routes:
                    if candidate['duration']<=cap+1e-6:
                        children.append((opportunity_score(candidate,cells, team=team),waypoints))
        completed+=len(jobs)
        all_states.extend(children)
        if not children:
            break
        if strategy=='greedy':
            frontier=distinct_states(all_states,1)
            if route_rank(frontier[0][0])>=old_best:
                break
        else:
            # Advance a full depth, even if a branch initially gains fewer squares.
            # Earlier incumbents remain in all_states and can never be lost.
            frontier=diverse_states(children,width)
    return all_states, {'refinement_requests':completed,'failed_candidates':failures,'beam_width':width}


def validate_waypoints(waypoints):
    if waypoints is None:
        return []
    if not isinstance(waypoints,list) or len(waypoints)>8:
        raise ValueError('Provide at most eight ordered waypoints.')
    result=[]
    for point in waypoints:
        if not isinstance(point,list) or len(point)!=2:
            raise ValueError('Waypoints must be [longitude, latitude].')
        if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point):
            raise ValueError('Waypoint coordinates must be finite numbers.')
        x,y=point
        if not -180<=x<=180 or not -90<=y<=90:
            raise ValueError('Waypoint coordinates out of range.')
        result.append(list(point))
    return result


def initial_detours(start,end,cells,budget,required, team='BLUE'):
    """Explore each required leg fairly, with a shared bound on routing requests."""
    if not required:
        return [[p] for p in exploration_points(start,end,cells,budget, team=team)]
    chain=[start,*required,end]
    queues=[exploration_points(a,b,cells,budget/(len(chain)-1), team=team) for a,b in zip(chain,chain[1:])]
    result=[]
    for depth in range(max((len(q) for q in queues),default=0)):
        for leg,queue in enumerate(queues):
            if depth<len(queue):
                result.append(required[:leg]+[queue[depth]]+required[leg:])
                if len(result)>=16:
                    return result
    return result


def route_stop_labels(via,required):
    labels=[]
    manual=0
    for point in via:
        if manual<len(required) and point==required[manual]:
            manual+=1
            labels.append(f'W{manual}')
        else:
            labels.append('exploration detour')
    return labels


def search_routes(start, end, cells, budget_seconds, router, progress=None, strategy='beam', workers=4, waypoints=None, team='BLUE'):
    team=validate_team(team)
    required=validate_waypoints(waypoints)
    if isinstance(workers,bool) or not isinstance(workers,int) or not 1 <= workers <= 16:
        raise ValueError('Routing workers must be between 1 and 16.')
    if strategy not in ('greedy','beam','compare'):
        raise ValueError('Search strategy must be greedy, beam, or compare.')
    def report(percent,message):
        if progress:
            progress({'percent':percent,'message':message})
    # Share initial exploration and request results across comparison strategies.
    cache={}
    cache_lock=threading.Lock()
    provider_requests=0
    provider_timings=[]
    def cached_router(points,alternatives=False):
        nonlocal provider_requests
        key=(tuple(tuple(p) for p in points),alternatives)
        with cache_lock:
            owner=key not in cache
            if owner:
                cache[key]=Future()
                provider_requests+=1
            future=cache[key]
        if owner:
            began=time.monotonic()
            failed=False
            try:
                routes=router(points,alternatives)
                via=[list(p) for p in points[1:-1]]
                future.set_result([dict(r,via_points=via,stop_labels=route_stop_labels(via,required)) for r in routes])
            except BaseException as error:
                failed=True
                future.set_exception(error)
            finally:
                with cache_lock:
                    provider_timings.append((time.monotonic()-began,failed))
        return future.result()
    report(2,'Finding the fastest baseline through your waypoints…' if required else 'Finding the fastest baseline route…')
    base=cached_router([start,*required,end],not required)
    baseline=min(base,key=lambda r:r['duration'])
    scored_base=opportunity_score(baseline,cells, team=team)
    cap=baseline['duration']+budget_seconds
    trials=[(r,list(required)) for r in base]
    failures=0
    detours=initial_detours(start,end,cells,budget_seconds,required, team=team) if budget_seconds else []
    report(10,f'Checking {len(detours)} territory detours with up to {workers} routing workers…')
    def exploration_progress(done,total):
        report(10+40*done/max(1,total),f'Checked {done} of {total} territory detours.')
    outcomes=routing_batch([[start,*via,end] for via in detours],cached_router,workers,exploration_progress)
    for via,(routes,error) in zip(detours,outcomes):
        if error:
            failures+=1
        else:
            trials.extend((r,via) for r in routes)
    report(50,'Scoring shared detours…')
    seeds=[(opportunity_score(r,cells, team=team),via) for r,via in trials if r['duration']<=cap+1e-6]
    modes=['greedy','beam'] if strategy=='compare' else [strategy]
    results={}
    shared_requests=provider_requests
    for index,mode in enumerate(modes):
        started=time.monotonic()
        before_requests=provider_requests
        lower=50+45*index/len(modes)
        span=45/len(modes)
        def refine_report(fraction,message):
            report(lower+span*fraction,message)
        if budget_seconds>0:
            states,stats=refine_routes(start,end,cells,seeds,cap,cached_router,mode,refine_report,workers=workers, team=team)
        else:
            states,stats=seeds,{'refinement_requests':0,'failed_candidates':0,'beam_width':6 if mode=='beam' else 1}
        ranked=[r for r,_ in distinct_states(states,len(states)+1)]
        useful=[r for r in ranked if r['target_count']>0]
        if mode=='beam':
            useful=[r for r,_ in diverse_states([(r,[]) for r in useful],6,minimum_difference=.2)]
        results[mode]={
            'routes':useful[:6 if mode=='beam' else 3], 'failed_candidates':failures+stats['failed_candidates'],
            'no_opportunities':not useful,
            'stats':dict(stats, strategy=mode, refinement_seconds=round(time.monotonic()-started,3),
                         new_provider_requests=provider_requests-before_requests, routing_workers=workers),
        }
        report(lower+span,f'{mode.title()} search complete.')
    active='beam' if strategy=='compare' else strategy
    report(95,'Ranking routes and preparing driving directions…')
    chosen=results[active]
    response=dict(chosen,baseline=scored_base,team=team,strategy=active,required_waypoints=required,
                  shared_provider_requests=shared_requests,total_provider_requests=provider_requests,
                  routing_metrics={'workers':workers,'mean_request_seconds':round(sum(t for t,_ in provider_timings)/max(1,len(provider_timings)),2),
                                   'failed_requests':sum(failed for _,failed in provider_timings)},
                  message='No target squares found within this budget. Increase extra driving time or change endpoints.'
                          if chosen['no_opportunities'] else 'Unmapped squares are exploration opportunities; radio coverage is unverified.')
    if strategy=='compare':
        response['strategy_results']=results
    return response
