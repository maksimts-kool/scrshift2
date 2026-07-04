import { useMemo, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  AppBar,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  CssBaseline,
  IconButton,
  Link,
  Paper,
  Slider,
  Stack,
  TextField,
  ThemeProvider,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Typography,
  createTheme,
  useMediaQuery,
} from "@mui/material";
import TrainIcon from "@mui/icons-material/Train";
import CasinoIcon from "@mui/icons-material/Casino";
import RouteIcon from "@mui/icons-material/Route";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import rawData from "./data/routes.json";
import type { RoutesData, Shift, ShiftLeg, Train } from "./types";
import { TURNAROUND_MIN, generateShift } from "./lib/generator";

const data = rawData as unknown as RoutesData;
const RANDOM_OPERATOR = "__random__";

const trainByName = new Map(data.trains.map((t) => [t.name, t]));

function operatorColor(name: string): string {
  return data.operators.find((o) => o.name === name)?.color ?? "#888";
}

/** Stations you can sign on at for an operator (all origins/destinations). */
function stationsForOperator(operator: string): string[] {
  const set = new Set<string>();
  for (const r of data.routes) {
    if (operator === RANDOM_OPERATOR || r.operator === operator) {
      set.add(r.origin);
      set.add(r.destination);
    }
  }
  return [...set].sort();
}

function defaultStartTime(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  const m = Math.ceil(d.getMinutes() / 5) * 5;
  const h = (d.getHours() + Math.floor(m / 60)) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function clockAt(startHHMM: string, offsetMin: number): string {
  const [h, m] = startHHMM.split(":").map(Number);
  const total = (((h * 60 + m + offsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function fmtDuration(min: number): string {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Colour + label per traction type, used for the roster dots and legend. */
const TRACTION: Record<Train["traction"], { label: string; color: string }> = {
  electric: { label: "Electric", color: "#0288d1" },
  diesel: { label: "Diesel", color: "#ed6c02" },
  bimode: { label: "Bi-mode", color: "#7b1fa2" },
};

/** Numeric part of a class name so "Class 43" sorts before "Class 350". */
function classNum(name: string): number {
  const m = name.match(/\d+/);
  return m ? Number(m[0]) : 9999;
}

/**
 * Every train legal on all legs of the shift, shown as tappable chips so the
 * driver can pick which one they'll actually run. This replaces the per-leg
 * "Stock: …" wiki sentence — the whole-shift roster is the number that matters.
 */
function TrainRoster({
  roster,
  selected,
  onSelect,
  accent,
}: {
  roster: Train[];
  selected: string | null;
  onSelect: (name: string) => void;
  accent: string;
}) {
  if (roster.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No single train can legally work every leg — the driver would swap stock, so no
        one-train roster is possible for this chain.
      </Typography>
    );
  }
  const tractions = [...new Set(roster.map((t) => t.traction))];
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <TrainIcon fontSize="small" sx={{ color: "text.secondary" }} />
        <Typography variant="body2" color="text.secondary">
          Any of these <strong>{roster.length}</strong> trains can work every leg — tap to
          pick yours
        </Typography>
      </Stack>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
        {roster.map((t) => {
          const on = t.name === selected;
          return (
            <Chip
              key={t.name}
              size="small"
              label={t.name}
              onClick={() => onSelect(t.name)}
              icon={
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: TRACTION[t.traction].color,
                    ml: "8px !important",
                  }}
                />
              }
              variant={on ? "filled" : "outlined"}
              sx={{
                cursor: "pointer",
                fontWeight: on ? 700 : 400,
                ...(on && { bgcolor: accent, color: "#fff" }),
              }}
            />
          );
        })}
      </Box>
      <Stack direction="row" spacing={1.5} sx={{ mt: 1, flexWrap: "wrap" }}>
        {tractions.map((tr) => (
          <Stack key={tr} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Box
              sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: TRACTION[tr].color }}
            />
            <Typography variant="caption" color="text.secondary">
              {TRACTION[tr].label}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function LegCard({ leg, index, startTime }: { leg: ShiftLeg; index: number; startTime: string }) {
  const color = operatorColor(leg.route.operator);
  const depart = clockAt(startTime, leg.departOffsetMin);
  const arrive = clockAt(startTime, leg.departOffsetMin + leg.durationMin);
  return (
    <Card variant="outlined" sx={{ borderLeft: `5px solid ${color}` }}>
      <CardContent sx={{ pb: 1, "&:last-child": { pb: 1 } }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
          <Chip size="small" label={`Leg ${index + 1}`} sx={{ bgcolor: color, color: "#fff", fontWeight: 600 }} />
          <Typography variant="h6" component="span" sx={{ fontFamily: "monospace" }}>
            {leg.route.code}
          </Typography>
          <Typography variant="h6" component="span" sx={{ flexGrow: 1, fontWeight: 400 }}>
            {leg.from} → {leg.to}
          </Typography>
          <Typography variant="body1" sx={{ fontFamily: "monospace" }}>
            {depart} → {arrive}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {fmtDuration(leg.durationMin)} · {leg.calls.length} calls · {leg.route.points} pts ·{" "}
          {leg.route.xp} XP{leg.reversed ? " · reverse direction" : ""}
        </Typography>
        <Accordion
          disableGutters
          elevation={0}
          sx={{ bgcolor: "transparent", "&:before": { display: "none" }, mt: 0.5 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 36 }}>
            <Typography variant="body2">Calling points</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0, pt: 0 }}>
            <Stack spacing={0.25}>
              {leg.calls.map((call, i) => {
                const isEnd = i === 0 || i === leg.calls.length - 1;
                return (
                  <Box key={`${call.name}-${i}`} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Typography
                      variant="body2"
                      sx={{ fontFamily: "monospace", width: 48, color: "text.secondary" }}
                    >
                      {clockAt(startTime, leg.departOffsetMin + call.minutesIntoLeg)}
                    </Typography>
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        border: `2px solid ${color}`,
                        bgcolor: isEnd ? color : "transparent",
                        flexShrink: 0,
                      }}
                    />
                    <Typography variant="body2" sx={{ fontWeight: isEnd ? 600 : 400 }}>
                      {call.name}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function delayLabel(min: number): string {
  if (min === 0) return "On time";
  return min > 0 ? `${min} min late` : `${-min} min early`;
}

function DelayControl({
  delayMin,
  onDelayChange,
}: {
  delayMin: number;
  onDelayChange: (v: number) => void;
}) {
  const late = delayMin > 0;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="body2" color="text.secondary">
        Running
      </Typography>
      <IconButton
        size="small"
        aria-label="less delay"
        onClick={() => onDelayChange(delayMin - 1)}
      >
        <RemoveIcon fontSize="small" />
      </IconButton>
      <Chip
        size="small"
        label={delayLabel(delayMin)}
        color={late ? "warning" : "default"}
        variant={delayMin === 0 ? "outlined" : "filled"}
        onDelete={delayMin !== 0 ? () => onDelayChange(0) : undefined}
        sx={{ minWidth: 96, fontWeight: 600 }}
      />
      <IconButton
        size="small"
        aria-label="more delay"
        onClick={() => onDelayChange(delayMin + 1)}
      >
        <AddIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}

function ShiftView({
  shift,
  startTime,
  onStartTimeChange,
  delayMin,
  onDelayChange,
  selectedTrain,
  onSelectTrain,
}: {
  shift: Shift;
  startTime: string;
  onStartTimeChange: (v: string) => void;
  delayMin: number;
  onDelayChange: (v: number) => void;
  selectedTrain: string | null;
  onSelectTrain: (name: string) => void;
}) {
  const color = operatorColor(shift.operator);
  const first = shift.legs[0];
  const last = shift.legs[shift.legs.length - 1];
  // A running delay just shifts every clock time, so retime from a moved base.
  const effectiveStart = clockAt(startTime, delayMin);
  const roster = shift.trainRoster
    .map((n) => trainByName.get(n))
    .filter((t): t is Train => t != null)
    .sort((a, b) => classNum(a.name) - classNum(b.name) || a.name.localeCompare(b.name));
  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 3 }}>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: "center", mb: 1, flexWrap: "wrap", gap: 1 }}
        >
          <Box sx={{ width: 14, height: 14, borderRadius: "50%", bgcolor: color }} />
          <Typography variant="h5" sx={{ flexGrow: 1 }}>
            {shift.operator} shift
          </Typography>
          <DelayControl delayMin={delayMin} onDelayChange={onDelayChange} />
        </Stack>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: "center", mb: 2, flexWrap: "wrap", gap: 1 }}
        >
          <TextField
            label="Start"
            type="time"
            size="small"
            value={startTime}
            onChange={(e) => onStartTimeChange(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 130 }}
          />
          <Typography variant="body1" color="text.secondary">
            → {clockAt(effectiveStart, shift.totalMin)} · sign on at <strong>{first.from}</strong>,
            sign off at <strong>{last.to}</strong>
            {delayMin !== 0 ? ` · ${delayLabel(delayMin)}` : ""}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1, mb: 2.5 }}>
          <Chip label={`${shift.legs.length} legs`} />
          <Chip label={fmtDuration(shift.totalMin)} />
          <Chip label={`${shift.totalPoints} points`} />
          <Chip label={`${shift.totalXp} XP`} />
        </Stack>
        <TrainRoster
          roster={roster}
          selected={selectedTrain}
          onSelect={onSelectTrain}
          accent={color}
        />
      </Paper>
      <Stack spacing={0}>
        {shift.legs.map((leg, i) => (
          <Box key={`${leg.route.code}-${i}`}>
            {i > 0 && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.75,
                  pl: 2,
                  color: "text.secondary",
                }}
              >
                <SwapVertIcon fontSize="small" />
                <Typography variant="body2">
                  Reverse at {leg.from}
                  {shift.turnaroundMin > 0 ? ` · ${shift.turnaroundMin} min turnaround` : ""}
                </Typography>
              </Box>
            )}
            <LegCard leg={leg} index={i} startTime={effectiveStart} />
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

export default function App() {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(
    () =>
      createTheme({
        palette: { mode: prefersDark ? "dark" : "light", primary: { main: "#0096EE" } },
      }),
    [prefersDark],
  );

  const [operator, setOperator] = useState<string>(data.operators[0]?.name ?? RANDOM_OPERATOR);
  const [mode, setMode] = useState<"legs" | "minutes">("minutes");
  const [legsTarget, setLegsTarget] = useState(4);
  const [minutesTarget, setMinutesTarget] = useState(90);
  const [turnaroundMin, setTurnaroundMin] = useState(TURNAROUND_MIN);
  const [startStation, setStartStation] = useState<string | null>(null);
  const [startTime, setStartTime] = useState(defaultStartTime);
  const [delayMin, setDelayMin] = useState(0);
  const [shift, setShift] = useState<Shift | null>(null);
  const [selectedTrain, setSelectedTrain] = useState<string | null>(null);

  const randomOperator = operator === RANDOM_OPERATOR;
  const stationOptions = useMemo(() => stationsForOperator(operator), [operator]);

  const onGenerate = () => {
    const op = randomOperator
      ? data.operators[Math.floor(Math.random() * data.operators.length)].name
      : operator;
    const next = generateShift(data, {
      operator: op,
      mode,
      target: mode === "legs" ? legsTarget : minutesTarget,
      turnaroundMin,
      // A specific sign-on station only makes sense with a specific operator.
      startStation: randomOperator ? null : startStation,
    });
    setDelayMin(0);
    setSelectedTrain(next?.train ?? null);
    setShift(next);
  };

  const scraped = new Date(data.scrapedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="sticky" elevation={1} color="default">
        <Toolbar>
          <TrainIcon sx={{ mr: 1.5, color: "primary.main" }} />
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            SCR Virtual Shift Generator
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {data.routes.length} routes ·{" "}
            <Link href={data.source} target="_blank" rel="noreferrer">
              SCR Wiki
            </Link>{" "}
            · {scraped}
          </Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Stack spacing={3}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="overline" color="text.secondary">
              Operator
            </Typography>
            <ToggleButtonGroup
              exclusive
              value={operator}
              onChange={(_, v) => {
                if (v === null) return;
                setOperator(v);
                setStartStation(null); // stations differ per operator
              }}
              sx={{ display: "flex", flexWrap: "wrap", mb: 2 }}
            >
              {data.operators.map((op) => (
                <ToggleButton key={op.name} value={op.name} sx={{ textTransform: "none" }}>
                  <Box
                    sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: op.color, mr: 1 }}
                  />
                  {op.name}
                </ToggleButton>
              ))}
              <ToggleButton value={RANDOM_OPERATOR} sx={{ textTransform: "none" }}>
                <CasinoIcon sx={{ fontSize: 16, mr: 1 }} />
                Random
              </ToggleButton>
            </ToggleButtonGroup>
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 1,
              }}
            >
              <Typography variant="overline" color="text.secondary">
                Shift length
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={mode}
                onChange={(_, v) => v !== null && setMode(v)}
              >
                <ToggleButton value="minutes" sx={{ textTransform: "none" }}>
                  By duration
                </ToggleButton>
                <ToggleButton value="legs" sx={{ textTransform: "none" }}>
                  By legs
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            <Box sx={{ px: 1, mb: 3 }}>
              {mode === "minutes" ? (
                <Slider
                  value={minutesTarget}
                  onChange={(_, v) => setMinutesTarget(v as number)}
                  min={30}
                  max={240}
                  step={15}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => fmtDuration(v)}
                  marks={[
                    { value: 60, label: "1 h" },
                    { value: 120, label: "2 h" },
                    { value: 180, label: "3 h" },
                  ]}
                />
              ) : (
                <Slider
                  value={legsTarget}
                  onChange={(_, v) => setLegsTarget(v as number)}
                  min={2}
                  max={12}
                  step={1}
                  valueLabelDisplay="auto"
                  marks={[
                    { value: 4, label: "4" },
                    { value: 8, label: "8" },
                    { value: 12, label: "12" },
                  ]}
                />
              )}
            </Box>
            <Typography variant="overline" color="text.secondary" sx={{ display: "block" }}>
              Turnaround at each terminus
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
              Layover added when changing ends. SCR has none — it's realism flavor.
            </Typography>
            <Box sx={{ px: 1, mb: 3 }}>
              <Slider
                value={turnaroundMin}
                onChange={(_, v) => setTurnaroundMin(v as number)}
                min={0}
                max={10}
                step={1}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => (v === 0 ? "none" : `${v} min`)}
                marks={[
                  { value: 0, label: "0" },
                  { value: 4, label: "4" },
                  { value: 10, label: "10" },
                ]}
              />
            </Box>
            <Typography variant="overline" color="text.secondary" sx={{ display: "block" }}>
              Sign on at
            </Typography>
            <Autocomplete
              options={stationOptions}
              value={startStation}
              onChange={(_, v) => setStartStation(v)}
              disabled={randomOperator}
              size="small"
              sx={{ mb: 3, maxWidth: 360 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={randomOperator ? "Pick an operator first" : "Any station"}
                  helperText={
                    randomOperator
                      ? "Choose a specific operator to pin the starting station"
                      : "Leave empty to start anywhere on the network"
                  }
                />
              )}
            />
            <Button
              variant="contained"
              size="large"
              startIcon={<RouteIcon />}
              onClick={onGenerate}
              fullWidth
            >
              {shift ? "Generate another shift" : "Generate shift"}
            </Button>
          </Paper>

          {shift ? (
            <ShiftView
              shift={shift}
              startTime={startTime}
              onStartTimeChange={setStartTime}
              delayMin={delayMin}
              onDelayChange={setDelayMin}
              selectedTrain={selectedTrain}
              onSelectTrain={setSelectedTrain}
            />
          ) : (
            <Paper variant="outlined" sx={{ p: 6, textAlign: "center", color: "text.secondary" }}>
              <TrainIcon sx={{ fontSize: 48, mb: 1 }} />
              <Typography>
                Pick an operator and shift length, then generate your first shift. Each leg ends
                where the next one begins — reverse at the terminus and keep driving.
              </Typography>
            </Paper>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>
            Fan-made tool for Stepford County Railway on Roblox. Route data scraped from the{" "}
            <Link href={data.source} target="_blank" rel="noreferrer">
              SCR Unofficial Wiki
            </Link>{" "}
            on {scraped}. Run <code>npm run scrape</code> to refresh. Not affiliated with SCR.
          </Typography>
        </Stack>
      </Container>
    </ThemeProvider>
  );
}
