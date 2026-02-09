# RenderDoc Perf Timeline

A visualization tool for RenderDoc performance counters. It transforms flat CSV data into an interactive, hierarchical timeline to help identify GPU bottlenecks.

![Preview](docs/timeline_preview.png)

## Features

- **Hierarchical Timeline:** View draw calls nested by markers, matching RenderDoc's Event Browser.
- **Dynamic Scaling:** Block widths are relative to the selected counter (Duration, Samples, etc.).
- **Plugin System:** Extend functionality with custom JavaScript plugins.
- **Advanced Diagnostics:**
  - **BoundDetector Advanced:** Evidence-based diagnosis of likely bottlenecks (ALU, memory, backend, sync, occupancy, etc.).
- **Zero Installation:** Single HTML file. No server required. Works entirely in your browser.

## How to Use

### 1. Export Data from RenderDoc
To visualize your capture, you need two files:

1. **Events Hierarchy:**
   - In the **Event Browser**, right-click and select **Export to TXT**.
   - Save as `example-events.txt` (or any name).
2. **Performance Counters:**
   - Open the **Performance Counter Viewer**.
   - Select your counters (NVIDIA Perf SDK counters recommended for the advanced plugin).
   - Click **Capture Counters**.
   - Click **Save to CSV**.
   - Save as `example-counters.csv` (or any name).

### 2. Visualize
- Open `main.html` in any modern browser.
- Drag & drop your `example-events.txt` and `example-counters.csv` into the header zones.
- Load the plugin (`bound-detector-advanced.js`) using the **+** button.

### 3. Quick Start with Examples
The repository includes `example-events.txt` and `example-counters.csv` so you can test the tool immediately.

## Included Plugin

### **BoundDetector Advanced**
Analyzes per-event metrics and global baselines to produce a diagnosis card: likely bound by texture/memory, ALU, backend/ROP, sync/idle, occupancy, or other common GPU limits.

## Metrics

- `metrics.json` contains the current (maximal) set of counters expected by the plugin.
- `metrics.md` documents the metric list and descriptions.
