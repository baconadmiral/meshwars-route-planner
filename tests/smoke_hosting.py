"""Live socket smoke test with local deterministic providers; no internet needed."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from teams import TEAMS
from places import current_week
BOARD=(ROOT/'tests/fixtures/hosting-board.json').read_bytes()


class Provider(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        path=urlsplit(self.path).path
        if path=='/get-nodes':
            body=BOARD
        elif path=='/places':
            body=json.dumps({'places':[],'park_boundaries':{'type':'FeatureCollection','features':[]},'week_start':current_week(),'truncated':False}).encode()
        elif path=='/scores':
            body=json.dumps({'teams':[{'team':team,'tiles':0,'checkin_points':0,'explorer_points':0,'total':0} for team in TEAMS]}).encode()
        elif path.startswith('/route/v1/driving/'):
            points=[[float(v) for v in p.split(',')] for p in path.rsplit('/',1)[1].split(';')]
            body=json.dumps({'code':'Ok','routes':[{'geometry':{'type':'LineString','coordinates':points},
                             'duration':100,'distance':1000,'legs':[]}]}).encode()
        else:
            self.send_error(404);return
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers();self.wfile.write(body)


def run():
    provider=ThreadingHTTPServer(('127.0.0.1',0),Provider)
    threading.Thread(target=provider.serve_forever,daemon=True).start()
    with tempfile.TemporaryDirectory() as directory:
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
        provider_url=f'http://127.0.0.1:{provider.server_port}'
        env=dict(os.environ,HOST='127.0.0.1',PORT=str(port),DATA_DIR=directory,
                 BOARD_PATH=str(ROOT/'tests/fixtures/hosting-board.json'),
                 MESHWARS_BOARD_URL=provider_url+'/get-nodes',MESHWARS_SCORES_URL=provider_url+'/scores',MESHWARS_PLACES_URL=provider_url+'/places',OSRM_URL=provider_url,
                 OSRM_REQUEST_INTERVAL='0',FREQMAPPER_PARTNER_TOKEN='',MESHWARS_API_KEY='')
        url=f'http://127.0.0.1:{port}'
        process=subprocess.Popen([sys.executable,str(ROOT/'hosting.py')],env=env,
                                 stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def get(path):
            with urlopen(url+path,timeout=3) as response:return json.load(response)
        try:
            deadline=time.monotonic()+10
            while True:
                try:
                    if get('/healthz')['status']=='ok' and get('/api/board')['source']=='live':break
                except (URLError,OSError):pass
                if process.poll() is not None or time.monotonic()>deadline:
                    raise AssertionError('Hosted server failed to become ready.')
                time.sleep(.1)
            assert get('/readyz')['status']=='ready'
            assert get('/api/board')['team_scores']['available']
            assert len(get('/api/board/status')['team_scores']['teams'])==7
            assert Path(directory,'team_scores.json').exists()
            assert Path(directory,'board.json').exists(), 'Feed cache was not persisted.'
            payload={'start':[.001,.001],'end':[.01,.001],'team':'RED','detour_minutes':0,
                     'allowed_bounds':{'west':0,'south':0,'east':.02,'north':.02}}
            request=Request(url+'/api/plan-stream',data=json.dumps(payload).encode(),
                            headers={'Content-Type':'application/json'})
            with urlopen(request,timeout=5) as response:
                assert response.headers['X-Accel-Buffering']=='no'
                first=json.loads(response.readline())
                assert first['type']=='progress'
                events=[json.loads(line) for line in response if line.strip()]
            assert events[-1]['type']=='result'
            assert events[-1]['team']=='RED'
            assert events[-1]['routes']
            # Background jobs finish after their creation connection closes.
            token='a'*64
            job_request=Request(url+'/api/searches/'+token,data=json.dumps(payload).encode(),
                                headers={'Content-Type':'application/json'})
            with urlopen(job_request,timeout=5) as response:
                assert response.status==202
                created=json.load(response)
            deadline=time.monotonic()+5
            while True:
                job=get('/api/searches/'+token)
                if job['state']!='running':break
                assert time.monotonic()<deadline, 'Background search did not finish.'
                time.sleep(.05)
            assert job['state']=='complete'
            assert job['result']['team']=='RED' and job['result']['routes']
            assert job['result']['board_revision']==events[-1]['board_revision']
            with urlopen(job_request,timeout=5) as response:
                assert json.load(response)['created_at']==created['created_at'], 'Retry duplicated a search.'
            cancel_request=Request(url+'/api/searches/'+'b'*64+'/cancel',data=b'{}',
                                   headers={'Content-Type':'application/json'})
            with urlopen(cancel_request,timeout=5) as response:
                assert json.load(response)['state']=='cancelled'
            track=dict(events[-1]['routes'][0],team='RED')
            share_request=Request(url+'/api/gpx-shares',data=json.dumps({'route':track}).encode(),
                                  headers={'Content-Type':'application/json'})
            with urlopen(share_request,timeout=5) as response:
                assert response.status==201
                share=json.load(response)
            with urlopen(url+share['download_path'],timeout=3) as response:
                assert response.headers['Cache-Control']=='no-store'
                assert 'red-route.gpx' in response.headers['Content-Disposition']
                ET.fromstring(response.read())
            with urlopen(url,timeout=3) as response:
                assert b'MESHWARS ROUTE PLANNER' in response.read()
        finally:
            process.terminate()
            try:
                output,error=process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill();process.communicate();raise
            provider.shutdown();provider.server_close()
        assert process.returncode==0, 'Hosted server failed graceful shutdown.'
    print('Hosted socket smoke passed: startup, health, readiness, live cache, streamed and resumable routes, idempotent retry, cancellation, GPX share/download, static UI, SIGTERM.')


if __name__=='__main__':run()
