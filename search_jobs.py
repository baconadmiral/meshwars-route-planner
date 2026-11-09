"""Bounded, token-addressed searches whose lifetime is independent of HTTP connections."""
import hashlib
import json
import re
import threading
import time


class SearchJobError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class SearchStopped(Exception):
    pass


class SearchJobs:
    def __init__(self, slots=None, stopping=None, retention_seconds=1800,
                 runtime_seconds=1800, max_records=16, clock=time.time):
        self.slots = slots if slots is not None else threading.BoundedSemaphore(2)
        self.stopping = stopping if stopping is not None else threading.Event()
        self.retention_seconds = retention_seconds
        self.runtime_seconds = runtime_seconds
        self.max_records = max_records
        self.clock = clock
        self._lock = threading.RLock()
        self._jobs = {}

    def _validate_token(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{64}', token):
            raise SearchJobError('Invalid search token.')

    def _prune(self, make_room=False):
        now = self.clock()
        for token, job in list(self._jobs.items()):
            if not job['active'] and now-job['finished_at'] >= self.retention_seconds:
                del self._jobs[token]
        if make_room and len(self._jobs) >= self.max_records:
            finished = [(job['finished_at'], token) for token, job in self._jobs.items() if not job['active']]
            if finished:
                del self._jobs[min(finished)[1]]

    def _check(self, job):
        if job['state'] == 'running':
            if self.stopping.is_set():
                job.update(state='error', error='Server is restarting. Please plan again.', finished_at=self.clock())
            elif self.clock()-job['created_at'] >= self.runtime_seconds:
                job.update(state='error', error='Search exceeded 30 minutes. Try a shorter trip.', finished_at=self.clock())
        if job['state'] != 'running':
            raise SearchStopped()

    def _snapshot(self, token, job):
        try:
            self._check(job)
        except SearchStopped:
            pass
        data = {'token': token, 'state': job['state'], 'progress': dict(job['progress']),
                'created_at': job['created_at'],
                'expires_at': (job['finished_at'] or job['created_at']+self.runtime_seconds)+self.retention_seconds}
        if job['state'] == 'complete':
            data['result'] = job['result']
        if job.get('error'):
            data['error'] = job['error']
        return data

    def start(self, token, payload, run):
        self._validate_token(token)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        with self._lock:
            self._prune()
            existing = self._jobs.get(token)
            if existing is not None:
                if existing['fingerprint'] not in (None, fingerprint):
                    raise SearchJobError('This search token belongs to different route settings.', 409)
                return self._snapshot(token, existing)
            self._prune(make_room=True)
            if self.stopping.is_set() or len(self._jobs) >= self.max_records or not self.slots.acquire(blocking=False):
                raise SearchJobError('Search capacity is busy. Please retry shortly.', 429)
            job = {'state': 'running', 'active': True, 'fingerprint': fingerprint,
                   'created_at': self.clock(), 'finished_at': None,
                   'progress': {'percent': 0, 'message': 'Starting route search…'}}
            self._jobs[token] = job

        def progress(update):
            with self._lock:
                self._check(job)
                job['progress'] = {'percent': update['percent'], 'message': str(update['message'])[:500]}

        def produce():
            try:
                with self._lock:
                    self._check(job)
                result = run(progress)
                if len(json.dumps(result).encode()) > 8*1024*1024:
                    raise ValueError('Search result is too large to retain. Try a shorter trip.')
                with self._lock:
                    self._check(job)
                    job.update(state='complete', result=result, finished_at=self.clock(),
                               progress={'percent': 100, 'message': 'Search complete'})
            except SearchStopped:
                pass
            except Exception as error:
                with self._lock:
                    if job['state'] == 'running':
                        job.update(state='error', finished_at=self.clock(),
                                   error=str(error) if isinstance(error, ValueError) else 'Route search unavailable. Please retry.')
            finally:
                with self._lock:
                    self.slots.release()
                    job['active'] = False

        try:
            threading.Thread(target=produce, daemon=True, name='resumable-route-search').start()
        except Exception:
            with self._lock:
                del self._jobs[token]
            self.slots.release()
            raise
        with self._lock:
            return self._snapshot(token, job)

    def get(self, token):
        self._validate_token(token)
        with self._lock:
            self._prune()
            if token not in self._jobs:
                raise SearchJobError('Search expired or the server restarted. Please plan again.', 404)
            return self._snapshot(token, self._jobs[token])

    def cancel(self, token):
        self._validate_token(token)
        with self._lock:
            self._prune()
            job = self._jobs.get(token)
            if job is None:
                # A cancel can overtake a retried creation POST after a disconnect.
                self._prune(make_room=True)
                if len(self._jobs) >= self.max_records:
                    raise SearchJobError('Search capacity is busy. Please retry shortly.', 429)
                job = {'active': False, 'fingerprint': None, 'created_at': self.clock(),
                       'progress': {'percent': 0, 'message': 'Search cancelled'}}
                self._jobs[token] = job
            if job.get('state') != 'complete':
                job.update(state='cancelled', finished_at=self.clock(), error='Search cancelled.')
            return self._snapshot(token, job)
