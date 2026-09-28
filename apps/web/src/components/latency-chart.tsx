'use client';

import { useEffect, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface LatencyPoint {
  /** ISO timestamp of the hour bucket. */
  hour: string;
  p50: number;
  p95: number;
}

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** p50/p95 latency per hour over the last 24h. Rendered only in the browser (local time labels). */
export function LatencyChart({ data }: { data: LatencyPoint[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (data.length === 0) {
    return <p className="flex h-40 items-center justify-center text-sm text-gray-400">No successful checks in the last 24 hours</p>;
  }
  if (!mounted) return <div className="h-40" />;

  return (
    <div className="h-40" data-testid="latency-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f3f4f6" vertical={false} />
          <XAxis dataKey="hour" tickFormatter={timeLabel} tick={{ fontSize: 11, fill: '#6b7280' }} minTickGap={24} />
          <YAxis unit=" ms" width={60} tick={{ fontSize: 11, fill: '#6b7280' }} />
          <Tooltip labelFormatter={(v) => timeLabel(String(v))} formatter={(value, name) => [`${value} ms`, String(name)]} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="p50" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p95" stroke="#d97706" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
