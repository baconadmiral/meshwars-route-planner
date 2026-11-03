"""Deterministic BLUE opportunity scoring and bounded candidate search."""
import math


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


def score(route, cells):
    coords = route['geometry']['coordinates']
    west, east = min(p[0] for p in coords), max(p[0] for p in coords)
    south, north = min(p[1] for p in coords), max(p[1] for p in coords)
    crossed = {}
    for cell in cells:
        if cell['east'] < west or cell['west'] > east or cell['north'] < south or cell['south'] > north:
            continue
        if any(intersects(a, b, cell) for a, b in zip(coords, coords[1:])):
            crossed[cell['cell_id']] = cell
    targets = [c for c in crossed.values() if c['owner_team'] != 'BLUE']
    return dict(route, square_count=len(crossed), target_count=len(targets),
                target_ids=[c['cell_id'] for c in targets])


def candidate_points(start, end, cells, limit=8):
    """Choose spatially separated non-BLUE targets near the trip corridor."""
    sx, sy = start
    ex, ey = end
    scale = max(.1, math.cos(math.radians((sy+ey)/2)))
    ranked = []
    direct = math.hypot((ex-sx)*scale, ey-sy)
    for c in cells:
        if c['owner_team'] == 'BLUE':
            continue
        x, y = (c['west']+c['east'])/2, (c['south']+c['north'])/2
        distance = math.hypot((x-sx)*scale, y-sy) + math.hypot((ex-x)*scale, ey-y)
        if distance <= direct + .08:
            ranked.append((distance, x, y))
    selected = []
    for _, x, y in sorted(ranked):
        if all(math.hypot((x-p[0])*scale, y-p[1]) > .008 for p in selected):
            selected.append([x, y])
        if len(selected) == limit:
            break
    return selected


def choose(routes, cells, budget_seconds, baseline_seconds):
    feasible = [score(r, cells) for r in routes if r['duration'] <= baseline_seconds + budget_seconds + 1e-6]
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


def opportunity_score(route, cells):
    known = {c['cell_id']: c for c in cells}
    visited = route_grid_cells(route['geometry']['coordinates'])
    enemy = sorted(k for k in visited if k in known and known[k]['owner_team'] != 'BLUE')
    unmapped = sorted(visited-known.keys())
    return dict(route, square_count=len(visited), target_count=len(enemy)+len(unmapped),
                target_ids=enemy+unmapped, enemy_count=len(enemy), unmapped_count=len(unmapped))


def exploration_points(start, end, cells, budget_seconds, limit=12):
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
                potential = sum(1 for dy in range(-2,3) for dx in range(-2,3)
                                if known.get(f'{row+dy}_{col+dx}', {}).get('owner_team') != 'BLUE')
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
    return selected + candidate_points(start,end,cells,limit=4)


def search_routes(start, end, cells, budget_seconds, router, progress=None):
    def report(percent, message):
        if progress:
            progress({'percent': percent, 'message': message})
    report(2, 'Finding the fastest baseline route…')
    base = router([start,end], True)
    report(10, 'Baseline found. Selecting territory detours…')
    baseline = min(base, key=lambda r:r['duration'])
    scored_base = opportunity_score(baseline,cells)
    cap = baseline['duration']+budget_seconds
    trials = [(r,[]) for r in base]
    failures = 0
    points = exploration_points(start,end,cells,budget_seconds) if budget_seconds else []
    for index, p in enumerate(points):
        report(10 + 55*index/max(1,len(points)), f'Checking territory detour {index+1} of {len(points)}…')
        try:
            trials.extend((r,[p]) for r in router([start,p,end]))
        except (ValueError, OSError):
            failures += 1
        report(10 + 55*(index+1)/max(1,len(points)), f'Checked {index+1} of {len(points)} detours ({failures} unavailable).')
    report(65, 'Scoring detours and selecting route extensions…')
    feasible = [(opportunity_score(r,cells), via) for r,via in trials if r['duration']<=cap+1e-6]
    feasible.sort(key=lambda pair:(-pair[0]['target_count'],pair[0]['duration']))
    # Build extension jobs up front so progress reports completed requests.
    extension_jobs = []
    for r, via in feasible[:2]:
        used = set(r['target_ids'])
        extensions = [p for p in points if f'{math.floor(p[1]/LAT_STEP)}_{math.floor(p[0]/LON_STEP)}' not in used]
        for p in extensions[:3]:
            extension_jobs.extend(([p]+via, via+[p]) if via else ([p],))
    for index, waypoints in enumerate(extension_jobs):
        report(65 + 30*index/max(1,len(extension_jobs)), f'Checking extended route {index+1} of {len(extension_jobs)}…')
        try:
            for candidate in router([start,*waypoints,end]):
                if candidate['duration']<=cap+1e-6:
                    trials.append((candidate,waypoints))
        except (ValueError, OSError):
            failures += 1
        report(65 + 30*(index+1)/max(1,len(extension_jobs)), f'Checked {index+1} of {len(extension_jobs)} extended routes.')
    report(95, 'Ranking routes and preparing driving directions…')
    unique = {}
    for r,_ in trials:
        if r['duration']<=cap+1e-6:
            key = str(r['geometry']['coordinates'])
            unique[key] = opportunity_score(r,cells)
    ranked = sorted(unique.values(),key=lambda r:(-r['target_count'],r['duration'],r['distance']))
    useful = [r for r in ranked if r['target_count']>0]
    return {'routes': useful[:3], 'baseline':scored_base, 'failed_candidates':failures,
            'team':'BLUE', 'no_opportunities':not useful,
            'message': 'No target squares found within this budget. Increase extra driving time or change endpoints.' if not useful else
                       'Unmapped squares are exploration opportunities; radio coverage is unverified.'}
