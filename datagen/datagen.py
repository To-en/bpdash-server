import json
import time
import random
import websocket
import ssl
import math
from collections import deque

# --- CONFIGURATION ---
WSS_URL = "ws://localhost:3000/ws"
# WSS_URL = "wss://blackpearl-ws-8z9a.onrender.com/ws?role=dashboard"
USE_SSL = WSS_URL.startswith("wss://")  # True for remote (wss), False for local (ws)
EVENT_MODE = "SKIDPAD" # Options: "SKIDPAD" or "ENDURANCE"
PUBLISH_RATE = 5.0
INTERVAL = 1.0 / PUBLISH_RATE

# Client identity (tagged on reconnect so server can track per-publisher seq)
CLIENT_ID = "datagen-sim"

# Offline buffer: if the WS drops, hold up to N messages and flush on reconnect.
# Sized for ~30s of data at full rate across all groups (~15 groups × 2 Hz × 30s = 900).
BUFFER_MAX = 2000
offline_buffer = deque(maxlen=BUFFER_MAX)

# Per-group monotonic sequence counters — lets the server detect gaps
seq_counters = {}

def next_seq(group):
    seq_counters[group] = seq_counters.get(group, -1) + 1
    return seq_counters[group]

# Track origin for synthetic GPS (Formula Student Michigan-ish)
GPS_ORIGIN_LAT = 42.6700
GPS_ORIGIN_LNG = -83.2200
METERS_PER_DEG_LAT = 111_320.0

class FSAEVehiclePhysics:
    def __init__(self):
        # Pack constants
        self.total_cells = 80
        self.r_internal_cell = 0.002 # 2mOhm per cell
        self.v_oc_full = 4.15 # Volts per cell
        self.energy_cap_kwh = 10.0
        self.current_energy_wh = 10000.0

        # Vehicle state
        self.velocity_ms = 0.0
        self.lat_g = 0.0
        self.long_g = 0.0
        self.motor_temp = 35.0
        self.inv_temp = 32.0
        self.elapsed_s = 0

        # Position + heading for GPS synthesis
        self.pos_x_m = 0.0
        self.pos_y_m = 0.0
        self.heading_rad = 0.0

        # Cell-level state (so DV/min/max are non-trivial)
        # Start with small per-cell OCV offset to create a spread
        self.cell_offsets_v = [random.uniform(-0.01, 0.01) for _ in range(self.total_cells)]

        # Fault latches (mostly clean; very occasional warns)
        self.fault_bits = [0] * 8  # per-BMU fault bitmasks

    def step(self):
        self.elapsed_s += INTERVAL

        if EVENT_MODE == "SKIDPAD":
            self._simulate_skidpad()
        else:
            self._simulate_endurance()

        # --- POWERTRAIN ---
        target_current = abs(self.long_g * 80) + abs(self.lat_g * 20) + (self.velocity_ms * 0.5)
        self.current = min(250, target_current + random.uniform(-2, 2))

        v_oc_pack = (self.current_energy_wh / 10000.0) * (self.v_oc_full * self.total_cells)
        r_pack = self.total_cells * self.r_internal_cell
        self.voltage = v_oc_pack - (self.current * r_pack)

        self.current_energy_wh -= (self.voltage * self.current * INTERVAL) / 3600

        # --- SUSPENSION (front) ---
        aero_downforce = (self.velocity_ms**2) * 0.01
        self.heave = 20 + aero_downforce + (abs(self.long_g) * 2) + random.uniform(-0.2, 0.2)
        self.roll = 22 + (self.lat_g * 8) + random.uniform(-0.1, 0.1)

        # --- REAR SUSPENSION (slightly different bias from front) ---
        self.rear_heave = 21 + aero_downforce * 1.1 + (abs(self.long_g) * 1.5) + random.uniform(-0.2, 0.2)
        self.rear_roll = 22 + (self.lat_g * 7) + random.uniform(-0.1, 0.1)

        # --- WHEEL SPEEDS ---
        # rad/s at wheel ≈ v / r_wheel (r ≈ 0.228m for 18"+tire)
        wheel_rad_s = self.velocity_ms / 0.228
        wheel_rpm = wheel_rad_s * 60 / (2 * math.pi)
        # Differential split on cornering — outside wheel spins faster
        diff = self.lat_g * 8
        self.wheel_rpm_l = max(0, wheel_rpm - diff) + random.uniform(-1, 1)
        self.wheel_rpm_r = max(0, wheel_rpm + diff) + random.uniform(-1, 1)

        # --- POSITION (integrate heading for GPS track) ---
        # Yaw rate from lat g and velocity: omega = a_lat / v
        if self.velocity_ms > 1.0:
            self.heading_rad += (self.lat_g * 9.81 / self.velocity_ms) * INTERVAL
        self.pos_x_m += self.velocity_ms * math.cos(self.heading_rad) * INTERVAL
        self.pos_y_m += self.velocity_ms * math.sin(self.heading_rad) * INTERVAL

        # --- THERMALS ---
        self.motor_temp += (self.current**2 * 0.000005) - 0.01
        self.inv_temp += (self.current**2 * 0.000002) - 0.005

    def _simulate_skidpad(self):
        t = self.elapsed_s % 25
        if t < 5:
            self.long_g = 0.8; self.lat_g = 0.0; self.velocity_ms = min(12, self.velocity_ms + 1)
        elif t < 15:
            self.long_g = 0.1; self.lat_g = 1.4; self.velocity_ms = 11.5
        else:
            self.long_g = 0.1; self.lat_g = -1.4; self.velocity_ms = 11.5

    def _simulate_endurance(self):
        self.long_g = math.sin(self.elapsed_s * 0.5) * 1.2
        self.lat_g = math.cos(self.elapsed_s * 0.3) * 1.5
        self.velocity_ms = max(2, min(28, self.velocity_ms + (self.long_g * 0.5)))

    def gps_lat_lng(self):
        meters_per_deg_lng = METERS_PER_DEG_LAT * math.cos(math.radians(GPS_ORIGIN_LAT))
        lat = GPS_ORIGIN_LAT + (self.pos_y_m / METERS_PER_DEG_LAT)
        lng = GPS_ORIGIN_LNG + (self.pos_x_m / meters_per_deg_lng)
        return lat, lng


car = FSAEVehiclePhysics()


def ts_now():
    return int(time.time() * 1000)


# ── FRONT NODE ──
def generate_front_data():
    ts = ts_now()
    return [
        {"type": "data", "group": "mech", "node": "front", "ts": ts, "d": {
            "STR_Heave_mm": round(car.heave, 2),
            "STR_Roll_mm": round(car.roll, 2),
        }},
        {"type": "data", "group": "elect", "node": "front", "ts": ts, "d": {
            "I_SENSE": round(car.current * 0.02, 2),
            "TMP": round(car.inv_temp, 1),
            "APPS": round(max(0, car.long_g * 50), 1),
            "BPPS": round(max(0, -car.long_g * 30), 1),
        }},
        # Faults are booleans: True = OK, False = fault (matches ESP32 output)
        {"type": "data", "group": "faults", "node": "front", "ts": ts, "d": {
            "AMS_OK": True, "IMD_OK": True, "HV_ON": True, "BSPD_OK": True,
        }},
    ]


# ── REAR NODE ──
def generate_rear_data():
    ts = ts_now()
    lat, lng = car.gps_lat_lng()
    return [
        {"type": "data", "group": "mech", "node": "rear", "ts": ts, "d": {
            "Wheel_RPM_L": round(car.wheel_rpm_l, 1),
            "Wheel_RPM_R": round(car.wheel_rpm_r, 1),
            "STR_Heave_mm": round(car.rear_heave, 2),
            "STR_Roll_mm": round(car.rear_roll, 2),
        }},
        {"type": "data", "group": "odom", "node": "rear", "ts": ts, "d": {
            "gps_lat": round(lat, 7),
            "gps_lng": round(lng, 7),
            "gps_age": random.randint(50, 150),
            "gps_course": round((math.degrees(car.heading_rad) + 360) % 360, 2),
            "gps_speed": round(car.velocity_ms * 3.6, 2),  # km/h
            "imu_accel_x": round(car.long_g, 3),
            "imu_accel_y": round(car.lat_g, 3),
            "imu_accel_z": round(1.0 + random.uniform(-0.05, 0.05), 3),
            "imu_gyro_x": round(random.uniform(-0.2, 0.2), 3),
            "imu_gyro_y": round(random.uniform(-0.2, 0.2), 3),
            "imu_gyro_z": round(car.lat_g * 0.5, 3),
        }},
    ]


# ── BAMO NODE ──
def generate_bamo_data():
    ts = ts_now()
    return [
        {"type": "data", "group": "bamo.power", "ts": ts, "d": {
            "canVoltage": round(car.voltage, 1),
            "canCurrent": round(car.current, 1),
            "power": round(car.voltage * car.current, 1),  # Watts (V*A). Display sites divide by 1000 for kW.
            "canVoltageValid": True,
            "canCurrentValid": True,
        }},
        {"type": "data", "group": "bamo.temp", "ts": ts, "d": {
            "motorTemp": round(car.motor_temp, 1),
            "controllerTemp": round(car.inv_temp, 1),
            "motorTempValid": True,
            "ctrlTempValid": True,
        }},
    ]


# ── AMS NODE (8 BMUs × 10 cells) ──
# Server applies: V_MODULE/V_CELL × 0.02, TEMP_SENSE × 0.5 − 40, DV × 0.1
# So we emit RAW integers here to match real firmware contract.
def generate_ams_data():
    ts = ts_now()
    messages = []
    avg_cell_v = car.voltage / car.total_cells  # real volts

    # Per-cell temperature roughly tracks motor temp (pack warms with load)
    pack_temp_c = (car.motor_temp - 10) + random.uniform(-1, 1)

    for i in range(8):
        cells_v = []
        for j in range(10):
            idx = i * 10 + j
            v_real = avg_cell_v + car.cell_offsets_v[idx] + random.uniform(-0.002, 0.002)
            cells_v.append(v_real)

        v_cell_raw = [max(0, min(65535, int(round(v / 0.02)))) for v in cells_v]
        v_module_raw = sum(v_cell_raw)

        # DV (spread) in raw units: scale = 0.1 V per count
        dv_real = max(cells_v) - min(cells_v)
        dv_raw = max(0, min(65535, int(round(dv_real / 0.1))))

        # TEMP_SENSE: raw = (celsius + 40) / 0.5
        t0 = pack_temp_c + random.uniform(-0.5, 0.5)
        t1 = pack_temp_c + random.uniform(-0.5, 0.5)
        temp_raw = [
            max(0, min(65535, int(round((t0 + 40) / 0.5)))),
            max(0, min(65535, int(round((t1 + 40) / 0.5)))),
        ]

        messages.append({"type": "data", "group": f"bmu{i}.cells", "ts": ts, "d": {
            "V_MODULE": v_module_raw,
            "V_CELL": v_cell_raw,
            "TEMP_SENSE": temp_raw,
            "DV": dv_raw,
            "connected": True,
        }})

        # Faults: bitmask flags, all nominal by default
        messages.append({"type": "data", "group": f"bmu{i}.faults", "ts": ts, "d": {
            "OV_WARN": 0, "OV_CRIT": 0,
            "LV_WARN": 0, "LV_CRIT": 0,
            "OT_WARN": 0, "OT_CRIT": 0,
            "ODV_WARN": 0, "ODV_CRIT": 0,
            "BAL_CELLS": 0,
            "NEED_BAL": 0,
        }})

    return messages


def connect():
    # x-client-id header lets the server tag per-publisher seq streams
    return websocket.create_connection(
        WSS_URL,
        header=[f"x-client-id: {CLIENT_ID}"],
        sslopt={"cert_reqs": ssl.CERT_NONE} if USE_SSL else {},
    )


def send_with_buffer(ws, msg):
    """Send immediately if connected, else buffer for flush on reconnect."""
    try:
        if ws is not None:
            ws.send(json.dumps(msg))
            return ws
    except Exception:
        # Connection just dropped — fall through to buffer this msg + reconnect
        ws = None

    offline_buffer.append(msg)
    return ws


def flush_buffer(ws):
    if not offline_buffer:
        return ws
    print(f"[BUFFER] Flushing {len(offline_buffer)} buffered message(s)")
    while offline_buffer:
        msg = offline_buffer.popleft()
        try:
            ws.send(json.dumps(msg))
        except Exception:
            # Still broken — put it back and bail
            offline_buffer.appendleft(msg)
            return None
    return ws


def run_simulator():
    ws = None
    print(f"SIMULATING {EVENT_MODE} MODE...")
    while True:
        t_start = time.time()

        # Try to (re)connect if down
        if ws is None:
            try:
                ws = connect()
                print("[WS] Connected")
                ws = flush_buffer(ws)
            except Exception as e:
                print(f"[WS] Reconnect failed ({e}); buffered={len(offline_buffer)}")

        car.step()
        msgs = (
            generate_front_data()
            + generate_rear_data()
            + generate_bamo_data()
            + generate_ams_data()
        )
        # Stamp seq onto each message before sending/buffering
        for m in msgs:
            m["seq"] = next_seq(m["group"])
            m["client_id"] = CLIENT_ID
            ws = send_with_buffer(ws, m)

        time.sleep(max(0, INTERVAL - (time.time() - t_start)))


if __name__ == "__main__":
    run_simulator()
