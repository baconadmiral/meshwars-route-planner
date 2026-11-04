"""Supported MeshWars teams shared by planning and navigation exports."""
TEAMS = ('BLUE', 'RED', 'GREEN', 'PURPLE', 'YELLOW', 'ORANGE', 'PINK')


def validate_team(team):
    if not isinstance(team, str) or team not in TEAMS:
        raise ValueError('Choose a supported team: ' + ', '.join(TEAMS) + '.')
    return team
