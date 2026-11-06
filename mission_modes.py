"""Mission objectives are ranking policies, separate from game capture rules."""
import math

MODES={
    'balanced':('Balanced Patrol','The original mix of enemy captures, exploration and estimated place bonuses.'),
    'offensive':('Offensive Strike','Prioritize vulnerable enemy squares; unpainted ground and place bonuses are secondary.'),
    'fortify':('Fortify','Reinforce low-score friendly squares, especially where they border enemy territory.'),
    'frontier':('Frontier Patrol','Expand into unpainted squares adjoining your team’s territory.'),
    'flanking':('Flanking Maneuver','Explore wider loops and prioritize opportunities away from the fastest baseline.'),
    'special_ops':('Special Operations','Seek eligible place bonuses within your remaining weekly allowance.'),
    'supply':('Supply Run','Make the trip productive while favoring opportunities requiring little extra time.'),
}


def validate_mission_mode(value='balanced'):
    if not isinstance(value,str) or value not in MODES:raise ValueError('Choose a valid mission mode.')
    return value


class MissionIndex(dict):
    def __init__(self,cells):
        super().__init__((c['cell_id'],c) for c in cells)
        self.cells=cells

    def get(self,key,default=None):
        if key in self:return super().get(key)
        if default is not None:return default
        return {'_mission_priority':self.cells.priority(key,None)}


class MissionCells(list):
    def __init__(self,rows,team,mode):
        self.team=team;self.mode=validate_mission_mode(mode)
        self.original={c['cell_id']:c for c in rows}
        self.baseline_seconds=0
        self.baseline_cells=set()
        self.place_multiplier={'offensive':.25,'fortify':0.,'frontier':.25,'flanking':.5,'special_ops':3.,'supply':1.}.get(mode,1.)
        super().__init__({**c,'_mission_priority':self.priority(c['cell_id'],c)} for c in rows)

    def adjacent(self,key,predicate):
        try:row,col=map(int,key.split('_'))
        except (TypeError,ValueError):return False
        return any(predicate(self.original.get(f'{row+dy}_{col+dx}')) for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)))

    def frontier(self,key):
        return self.adjacent(key,lambda c:bool(c and c['owner_team']==self.team))

    def priority(self,key,cell):
        mode=self.mode
        if cell is None:
            if mode in ('fortify','special_ops'):return 0.
            if mode=='offensive':return .2
            if mode=='frontier':return 2. if self.frontier(key) else .15
            return 1.
        friendly=cell['owner_team']==self.team
        scores=cell.get('scores');value=scores.get(cell['owner_team']) if isinstance(scores,dict) else None
        points=value if not isinstance(value,bool) and isinstance(value,(int,float)) and math.isfinite(value) and value>=0 else None
        if mode=='fortify':
            if not friendly:return 0.
            base=.25 if points is None else 2./(1.+points)
            border=self.adjacent(key,lambda c:bool(c and c['owner_team']!=self.team))
            return base*(1.5 if border else 1.)
        if friendly or mode=='special_ops':return 0.
        base=.5 if points is None else 1. if points<=1 else (1./points)**2
        return base*{'offensive':3.,'frontier':.2}.get(mode,1.)

    def category(self,key):
        cell=self.original.get(key)
        if cell is None:return 'Adjacent unpainted' if self.mode=='frontier' and self.frontier(key) else 'Unpainted exploration'
        if cell['owner_team']==self.team:return 'Friendly reinforcement' if self.mode=='fortify' else 'Friendly territory'
        points=cell.get('scores',{}).get(cell['owner_team']) if isinstance(cell.get('scores'),dict) else None
        if isinstance(points,bool) or not isinstance(points,(int,float)) or not math.isfinite(points) or points<0:return 'Enemy score unknown'
        return 'Easy enemy squares' if points<=1 else 'Defended enemy squares'

    def score(self,visited,duration,place_bonus,place_weight):
        groups={}
        targets=[];reinforcement=[];frontier=[]
        for key in sorted(visited):
            cell=self.original.get(key);value=self.priority(key,cell)
            if value<=0:continue
            targets.append(key)
            if self.mode=='fortify' and cell and cell['owner_team']==self.team:reinforcement.append(key)
            if cell is None and self.frontier(key):frontier.append(key)
            label=self.category(key)
            group=groups.setdefault(label,{'label':label,'count':0,'priority':0.})
            group['count']+=1;group['priority']+=value
        territory=sum(group['priority'] for group in groups.values())
        places=place_bonus*place_weight*self.place_multiplier
        extra=max(0.,duration-self.baseline_seconds)
        multiplier=1.
        if self.mode=='supply':multiplier=1./(1.+extra/180.)
        if self.mode=='flanking':multiplier=1.+.75*len(visited-self.baseline_cells)/max(1,len(visited))
        return {'mission_mode':self.mode,'mission_target_ids':targets,'mission_target_count':len(targets),
                'reinforcement_ids':reinforcement,'reinforcement_count':len(reinforcement),
                'frontier_count':len(frontier),'mission_breakdown':list(groups.values()),
                'mission_territory_value':territory,'mission_place_value':places,
                'mission_place_multiplier':self.place_multiplier,'mission_multiplier':multiplier,
                'capture_value':(territory+places)*multiplier}


def mission_index(cells):
    return MissionIndex(cells) if isinstance(cells,MissionCells) else {c['cell_id']:c for c in cells}
