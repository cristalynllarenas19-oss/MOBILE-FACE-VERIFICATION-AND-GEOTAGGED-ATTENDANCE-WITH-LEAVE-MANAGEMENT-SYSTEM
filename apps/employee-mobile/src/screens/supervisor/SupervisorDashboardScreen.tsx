import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle } from "react-native-svg";
import { DashboardSummary, getDashboardSummary } from "../../api";

type Props = {
  departmentName?: string;
};

const RING_SIZE = 78;
const RING_STROKE = 10;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function KpiChip({ icon, label, value, tint }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: number | string; tint: string }) {
  return (
    <View style={styles.kpiChip}>
      <View style={[styles.kpiIconWrap, { backgroundColor: `${tint}17` }]}>
        <Ionicons name={icon} size={14} color={tint} />
      </View>
      <View style={styles.kpiTextCol}>
        <Text style={styles.kpiValue} numberOfLines={1}>{value}</Text>
        <Text style={styles.kpiLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{label}</Text>
      </View>
    </View>
  );
}

function MiniProgress({
  icon,
  tint,
  title,
  value,
  total,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  title: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <View style={styles.miniCard}>
      <View style={styles.miniHeaderRow}>
        <View style={[styles.miniIconWrap, { backgroundColor: `${tint}17` }]}>
          <Ionicons name={icon} size={13} color={tint} />
        </View>
        <Text style={styles.miniTitle} numberOfLines={1}>{title}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: tint }]} />
      </View>
      <Text style={styles.miniFraction} numberOfLines={1}>{value}/{total} · {pct}%</Text>
    </View>
  );
}

export default function SupervisorDashboardScreen({ departmentName }: Props) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setIsRefreshing(true) : setIsLoading(true);
    try {
      const data = await getDashboardSummary();
      setSummary(data);
    } catch (error) {
      console.error("Failed to load dashboard summary", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#062B59" size="large" />
      </View>
    );
  }

  const stats = summary?.stats ?? {
    totalEmployees: 0,
    presentToday: 0,
    lateToday: 0,
    absentToday: 0,
    pendingLeaves: 0,
    geotaggedLogs: 0,
  };

  const unmarked = Math.max(0, stats.totalEmployees - stats.presentToday - stats.lateToday - stats.absentToday);

  const segments = [
    { key: "present", label: "Present", value: stats.presentToday, color: "#1BAF7A" },
    { key: "late", label: "Late", value: stats.lateToday, color: "#EDA100" },
    { key: "absent", label: "Absent", value: stats.absentToday, color: "#E34948" },
    { key: "unmarked", label: "Not yet logged", value: unmarked, color: "#E2E8F0" },
  ].filter((s) => s.value > 0);

  let cumulativeOffset = 0;
  const ringSegments =
    stats.totalEmployees > 0
      ? segments.map((segment) => {
          const length = (segment.value / stats.totalEmployees) * RING_CIRCUMFERENCE;
          const offset = cumulativeOffset;
          cumulativeOffset += length;
          return { ...segment, length, offset };
        })
      : [];

  const attendedPct = stats.totalEmployees > 0 ? Math.round(((stats.presentToday + stats.lateToday) / stats.totalEmployees) * 100) : 0;

  return (
    <View style={styles.container}>
      <View style={styles.heroCard}>
        <View style={styles.heroIconWrap}>
          <Ionicons name="business" size={20} color="#FFFFFF" />
        </View>
        <View style={styles.heroTextCol}>
          <Text style={styles.heroTitle} numberOfLines={1}>{departmentName ?? "Your Team"}</Text>
          <Text style={styles.heroSubtitle} numberOfLines={1}>{summary?.calendar.monthLabel ?? "This month"}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
          onPress={() => load(true)}
          disabled={isRefreshing}
          hitSlop={8}
        >
          {isRefreshing ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="refresh" size={17} color="#FFFFFF" />}
        </Pressable>
      </View>

      <View style={styles.kpiRow}>
        <KpiChip icon="people" label="Employees" value={stats.totalEmployees} tint="#1680D8" />
        <KpiChip icon="calendar" label="Pending" value={stats.pendingLeaves} tint="#7C3AED" />
        <KpiChip icon="location" label="Geo Logs" value={stats.geotaggedLogs} tint="#0EA5E9" />
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>Today's Attendance</Text>
          <Text style={styles.cardSubtleLabel}>{attendedPct}% attended</Text>
        </View>

        {stats.totalEmployees === 0 ? (
          <Text style={styles.emptyRingText}>No employees in this department yet.</Text>
        ) : (
          <View style={styles.ringRow}>
            <View style={styles.ringWrap}>
              <Svg width={RING_SIZE} height={RING_SIZE}>
                <Circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="#F1F5F9" strokeWidth={RING_STROKE} />
                {ringSegments.map((segment) => (
                  <Circle
                    key={segment.key}
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={RING_STROKE}
                    strokeDasharray={`${segment.length} ${RING_CIRCUMFERENCE - segment.length}`}
                    strokeDashoffset={-segment.offset}
                    strokeLinecap="butt"
                    transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                  />
                ))}
              </Svg>
              <View style={styles.ringCenter}>
                <Text style={styles.ringValue} numberOfLines={1} adjustsFontSizeToFit>{stats.presentToday + stats.lateToday}</Text>
                <Text style={styles.ringLabel} numberOfLines={1}>of {stats.totalEmployees}</Text>
              </View>
            </View>

            <View style={styles.legendCol}>
              <LegendRow color="#1BAF7A" label="Present" value={stats.presentToday} />
              <LegendRow color="#EDA100" label="Late" value={stats.lateToday} />
              <LegendRow color="#E34948" label="Absent" value={stats.absentToday} />
              <LegendRow color="#CBD5E1" label="Not logged" value={unmarked} />
            </View>
          </View>
        )}
      </View>

      <View style={styles.miniRow}>
        <MiniProgress icon="scan-outline" tint="#1680D8" title="Enrollment" value={summary?.enrollment.enrolled ?? 0} total={summary?.enrollment.total ?? 0} />
        <MiniProgress icon="location-outline" tint="#0EA5E9" title="Geotagged" value={summary?.geotagging.assigned ?? 0} total={summary?.geotagging.total ?? 0} />
      </View>
    </View>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.legendValue}>{value}</Text>
    </View>
  );
}

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { flex: 1 },

  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#062B59",
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 10,
    shadowColor: "#062B59",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  heroIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroTextCol: { flex: 1, minWidth: 0 },
  heroTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },
  heroSubtitle: { color: "#B9CBE0", fontSize: 12, marginTop: 2 },
  refreshButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  refreshButtonPressed: { opacity: 0.7 },

  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  kpiChip: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 11,
    ...cardShadow,
  },
  kpiIconWrap: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  kpiTextCol: { flex: 1, minWidth: 0 },
  kpiValue: { fontSize: 17, fontWeight: "800", color: "#062B59" },
  kpiLabel: { fontSize: 11, color: "#64748B", fontWeight: "500" },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
    ...cardShadow,
  },
  cardHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 },
  cardTitle: { flex: 1, fontSize: 13, fontWeight: "700", color: "#062B59" },
  cardSubtleLabel: { fontSize: 11, fontWeight: "700", color: "#1BAF7A", flexShrink: 0 },
  emptyRingText: { fontSize: 12, color: "#94A3B8", textAlign: "center", paddingVertical: 8 },

  ringRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  ringWrap: { width: RING_SIZE, height: RING_SIZE, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  ringCenter: { position: "absolute", alignItems: "center" },
  ringValue: { fontSize: 19, fontWeight: "800", color: "#062B59" },
  ringLabel: { fontSize: 9.5, color: "#64748B", marginTop: 1 },

  legendCol: { flex: 1, minWidth: 0, gap: 8 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  legendDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  legendLabel: { flex: 1, minWidth: 0, fontSize: 11, color: "#475569", fontWeight: "600" },
  legendValue: { fontSize: 12, fontWeight: "800", color: "#062B59", flexShrink: 0 },

  miniRow: { flexDirection: "row", gap: 10 },
  miniCard: { flex: 1, minWidth: 0, backgroundColor: "#FFFFFF", borderRadius: 14, padding: 12, ...cardShadow },
  miniHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  miniIconWrap: { width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  miniTitle: { flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: "700", color: "#062B59" },
  progressTrack: { height: 6, borderRadius: 999, backgroundColor: "#F1F5F9", overflow: "hidden" },
  progressFill: { height: 6, borderRadius: 999 },
  miniFraction: { fontSize: 10, color: "#94A3B8", marginTop: 6, fontWeight: "600" },
});
