import React, { useEffect, useState } from 'react';
import { ArrowLeft, Pause, Play, Square } from 'lucide-react';
import { Card, CardContent } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import type { ExecutionEvent } from '../types';

export function ExecutionDashboard() {
  const [stats, setStats] = useState({
    total: 45,
    current: 24,
    passed: 22,
    failed: 2,
    skipped: 0,
  });

  const [events, setEvents] = useState<ExecutionEvent[]>([
    {
      type: 'TestCaseBegin',
      timestamp: new Date().toISOString(),
      run_id: '123',
      test_name: 'Login Test',
    },
    {
      type: 'TestCaseEnd',
      timestamp: new Date().toISOString(),
      run_id: '123',
      test_name: 'Login Test',
      status: 'passed',
      duration_ms: 150,
      http_status: 200,
    },
  ]);

  const progress = (stats.current / stats.total) * 100;

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <button className="flex items-center gap-2 text-neutral-600 hover:text-neutral-900">
              <ArrowLeft className="w-5 h-5" />
              <span className="font-medium">Back to Project</span>
            </button>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" size="sm">
              <Pause className="w-4 h-4 mr-2" />
              Pause
            </Button>
            <Button variant="danger" size="sm">
              <Square className="w-4 h-4 mr-2" />
              Stop
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-4 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-neutral-500">Progress</p>
              <p className="text-3xl font-bold text-neutral-900 mt-1">
                {stats.current}/{stats.total}
              </p>
              <p className="text-sm text-neutral-500 mt-1">{Math.round(progress)}%</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-neutral-500">Passed</p>
              <p className="text-3xl font-bold text-success-600 mt-1">{stats.passed}</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-neutral-500">Failed</p>
              <p className="text-3xl font-bold text-error-600 mt-1">{stats.failed}</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-neutral-500">Skipped</p>
              <p className="text-3xl font-bold text-neutral-600 mt-1">{stats.skipped}</p>
            </CardContent>
          </Card>
        </div>

        {/* Progress Bar */}
        <div className="mb-8">
          <div className="h-8 bg-neutral-200 rounded-lg overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary-500 to-primary-600 flex items-center justify-center text-white font-medium text-sm transition-all duration-500"
              style={{ width: `${progress}%` }}
            >
              {Math.round(progress)}% Complete
            </div>
          </div>
        </div>

        {/* Execution Log */}
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-lg font-semibold mb-4">Execution Log</h2>
            <div className="bg-neutral-900 rounded-lg p-4 h-96 overflow-y-auto font-mono text-sm">
              {events.map((event, i) => (
                <div key={i} className="text-neutral-100 mb-2">
                  <span className="text-neutral-500">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>{' '}
                  {event.type === 'TestCaseBegin' && (
                    <span>
                      🧪 <span className="text-primary-400">{event.test_name}</span> started
                    </span>
                  )}
                  {event.type === 'TestCaseEnd' && (
                    <span>
                      {event.status === 'passed' ? '✅' : '❌'}{' '}
                      <span className="text-primary-400">{event.test_name}</span>{' '}
                      {event.status} ({event.duration_ms}ms)
                    </span>
                  )}
                </div>
              ))}
              <div className="animate-pulse">▂</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
