"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export type LapPositionData = {
  lap: number;
  [driverName: string]: number;
};

type Props = {
  data: LapPositionData[];
  drivers: string[];
  driverCount: number;
};

const LINE_COLORS = [
  "#FF8000",
  "#FF6B35",
  "#E55A2B",
  "#CC4A22",
  "#B33A18",
  "#992B0F",
  "#801C05",
  "#661500",
  "#4D9BFF",
  "#3DDC84",
  "#E040FB",
  "#FFEB3B",
  "#00BCD4",
  "#FF5252",
  "#7C4DFF",
  "#64FFDA",
];

export function LapPositionChart({ data, drivers, driverCount }: Props) {
  if (data.length === 0 || drivers.length === 0) {
    return null;
  }

  return (
    <div className="border border-white/10 bg-black/20 p-5 mt-4">
      <h3 className="font-sans font-black text-[10px] uppercase tracking-[0.2em] text-white/40 mb-5">
        Lap-by-Lap Positions
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
          />
          <XAxis
            dataKey="lap"
            tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
            label={{
              value: "Lap",
              position: "insideBottomRight",
              offset: -5,
              style: { fill: "rgba(255,255,255,0.25)", fontSize: 9, fontWeight: 700 },
            }}
          />
          <YAxis
            reversed
            domain={[1, driverCount]}
            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={32}
            allowDecimals={false}
            label={{
              value: "Position",
              angle: -90,
              position: "insideLeft",
              offset: 10,
              style: { fill: "rgba(255,255,255,0.25)", fontSize: 9, fontWeight: 700 },
            }}
          />
          <Tooltip
            contentStyle={{
              background: "#1B1B1B",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 0,
              fontSize: 11,
              padding: "8px 12px",
            }}
            labelStyle={{ color: "white", fontWeight: 700, marginBottom: 4 }}
            labelFormatter={(value) => `Lap ${value}`}
            formatter={(value) => [`P${value}`]}
            itemStyle={{ padding: "1px 0" }}
          />
          <Legend
            wrapperStyle={{ fontSize: 9, fontWeight: 700 }}
            iconType="plainline"
            iconSize={12}
          />
          {drivers.map((driver, i) => (
            <Line
              key={driver}
              type="monotone"
              dataKey={driver}
              stroke={LINE_COLORS[i % LINE_COLORS.length]}
              strokeWidth={i === 0 ? 2.5 : 1.5}
              dot={{ r: 2, fill: LINE_COLORS[i % LINE_COLORS.length] }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
