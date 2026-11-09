"""Search lifetimes, idempotency and capacity without an HTTP reader."""
import threading
import time
import unittest
from unittest.mock import patch

from search_jobs import SearchJobs, SearchJobError


TOKEN = 'a'*64


def eventually(predicate):
    deadline = time.monotonic()+2
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError('Background search did not reach the expected state.')


class SearchJobTests(unittest.TestCase):
    def test_finishes_without_a_reader_and_repeated_create_does_not_restart(self):
        jobs=SearchJobs()
        began, finish = threading.Event(), threading.Event()
        calls=[]
        def run(progress):
            calls.append(1);began.set();finish.wait(2)
            progress({'percent':80,'message':'Almost done'})
            return {'routes':['finished']}
        try:
            jobs.start(TOKEN, {'start':[0,0]}, run)
            self.assertTrue(began.wait(1))
            self.assertEqual(jobs.start(TOKEN, {'start':[0,0]}, run)['state'],'running')
        finally:
            finish.set()
        eventually(lambda:jobs.get(TOKEN)['state']=='complete')
        self.assertEqual(jobs.get(TOKEN)['result'],{'routes':['finished']})
        self.assertEqual(calls,[1])
        with self.assertRaises(SearchJobError) as error:
            jobs.start(TOKEN, {'start':[1,1]}, run)
        self.assertEqual(error.exception.status,409)

    def test_cancel_is_explicit_and_slot_released_when_worker_unwinds(self):
        slots=threading.BoundedSemaphore(1)
        jobs=SearchJobs(slots=slots)
        began, finish=threading.Event(),threading.Event()
        def run(progress):
            began.set();finish.wait(2);progress({'percent':20,'message':'Continue'})
            self.fail('Cancelled worker must stop at progress checkpoint')
        try:
            jobs.start(TOKEN, {}, run);self.assertTrue(began.wait(1))
            with self.assertRaises(SearchJobError) as error:
                jobs.start('b'*64,{},lambda progress:{})
            self.assertEqual(error.exception.status,429)
            self.assertEqual(jobs.cancel(TOKEN)['state'],'cancelled')
        finally:finish.set()
        eventually(lambda:not jobs._jobs[TOKEN]['active'])
        self.assertTrue(slots.acquire(blocking=False));slots.release()

    def test_cancel_overtaking_creation_prevents_abandoned_work(self):
        jobs=SearchJobs()
        jobs.cancel(TOKEN)
        result=jobs.start(TOKEN,{},lambda progress:self.fail('Must not start'))
        self.assertEqual(result['state'],'cancelled')

    def test_expiry_and_bounded_retention(self):
        now=[1000]
        jobs=SearchJobs(clock=lambda:now[0],retention_seconds=10,max_records=2)
        for token in [TOKEN,'b'*64,'c'*64]:
            jobs.start(token,{},lambda progress:{})
            eventually(lambda:not jobs._jobs[token]['active'])
            now[0]+=1
        self.assertEqual(len(jobs._jobs),2)
        with self.assertRaises(SearchJobError) as missing:jobs.get(TOKEN)
        self.assertEqual(missing.exception.status,404)
        now[0]+=10
        with self.assertRaises(SearchJobError):jobs.get('c'*64)

    def test_runtime_limit_and_private_worker_errors(self):
        now=[1000]
        jobs=SearchJobs(clock=lambda:now[0],runtime_seconds=10)
        def slow(progress):
            now[0]+=11
            progress({'percent':1,'message':'Late'})
            self.fail('Expired worker must stop')
        jobs.start(TOKEN,{},slow)
        eventually(lambda:not jobs._jobs[TOKEN]['active'])
        self.assertEqual(jobs.get(TOKEN)['state'],'error')
        self.assertIn('exceeded',jobs.get(TOKEN)['error'])
        jobs.start('b'*64,{},lambda progress:1/0)
        eventually(lambda:not jobs._jobs['b'*64]['active'])
        self.assertNotIn('division',jobs.get('b'*64)['error'])

    def test_invalid_tokens_and_thread_start_failure_do_not_consume_capacity(self):
        slots=threading.BoundedSemaphore(1)
        jobs=SearchJobs(slots=slots)
        for token in ('short','../private','g'*64):
            with self.assertRaises(SearchJobError):jobs.start(token,{},lambda progress:{})
        with patch('search_jobs.threading.Thread.start',side_effect=RuntimeError('cannot start')):
            with self.assertRaises(RuntimeError):jobs.start(TOKEN,{},lambda progress:{})
        self.assertTrue(slots.acquire(blocking=False));slots.release()
        self.assertEqual(jobs._jobs,{})
