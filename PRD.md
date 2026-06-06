# Product Requirements Document — Lap Simulator

## Overview

A browser-based motorsport lap simulation tool for personal engineering use. Given a track and vehicle configuration, it computes a minimum-time velocity profile using a quasi-static G-G diagram approach and visualizes the results.

**Target users:** Solo use (personal engineering tool)  
**Platform:** Web app (browser, no backend required for MVP)

---

## Physics Model

**Quasi-static minimum-time simulation** using the G-G diagram (friction circle) method:

1. Represent the track as a curvature profile (distance vs. radius of curvature).
2. Define the vehicle's combined grip envelope as a G-G diagram (lateral vs. longitudinal acceleration limits).
3. Compute the maximum speed at each track point constrained by lateral grip (`v = sqrt(ay_max * R)`).
4. Apply a forward/backward integration pass to enforce longitudinal acceleration and braking limits, producing a physically consistent velocity profile.

This is the industry-standard approach for point-mass lap time simulation.

---

## Vehicle Parameters

All four parameter groups are configurable per simulation run:

| Group | Parameters |
|---|---|
| **Aerodynamics** | Drag coefficient (CdA), downforce coefficient (ClA), aero balance (front/rear split), speed-dependent load curves |
| **Powertrain** | Power/torque curve (or peak power + shape), gear ratios, final drive ratio, drivetrain efficiency |
| **Tires** | Peak lateral/longitudinal grip (mu), combined grip envelope shape, compound selector (soft/medium/hard), degradation model (optional post-MVP) |
| **Weight & Balance** | Total mass, CoG height, wheelbase, front weight distribution, yaw moment of inertia |

Vehicle types: Formula/single-seater, kart, and generic configurable.

---

## Track Input

Two input methods:

1. **Manual definition** — user draws or specifies track geometry in the UI: sequence of straights and corners defined by length and radius.
2. **Import** — upload GPS/telemetry data (e.g. GPX, CSV with lat/lon) or pull from a track database (FastF1 or similar). Imported data is converted to a curvature profile.

---

## MVP Scope

**Single run: one car, one track.**

The user:
1. Defines or imports a track.
2. Configures vehicle parameters.
3. Runs the simulation.
4. Views results.

No user accounts, no persistence, no multi-run comparison in MVP.

---

## Outputs

### 1. Lap Time & Sectors
- Total simulated lap time.
- Sector times (user-defined or auto-split into thirds).

### 2. Speed & Force Traces
- Speed vs. distance plot.
- Longitudinal acceleration/deceleration vs. distance.
- Lateral acceleration vs. distance.

### 3. G-G Diagram Visualization
- Plot of the vehicle's grip envelope.
- Overlay of simulated lateral vs. longitudinal g at each track point.
- Shows how close the sim runs to the limit around the lap.

### 4. Racing Line & Live G-Force
- 2D track map with the simulated racing line drawn on it.
- Color-coded by speed or g-loading.
- Animated playback: a point moves around the track showing live speed and g-force values.

### 5. Setup Comparison (post-MVP)
- Side-by-side delta of lap time, speed trace, and g-g utilization between two vehicle configs.

---

## Tech Constraints

- Runs entirely in the browser (no server-side simulation required for MVP).
- Simulation core written in a way that can be extracted to a library later.
- No build-time dependency on real car data — all parameters are user-supplied.

---

## Out of Scope (MVP)

- Full vehicle dynamics (suspension, tire contact patch, yaw model).
- Tire degradation.
- Multi-car sessions or head-to-head.
- User accounts or saved sessions.
- Setup comparison view.
- Real-time telemetry ingestion.
