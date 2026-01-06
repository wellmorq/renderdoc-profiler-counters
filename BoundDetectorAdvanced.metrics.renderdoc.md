# BoundDetectorAdvanced — RenderDoc metrics pack

---

## Generic (RenderDoc pipeline stats)
- `GPU Duration`
- `Input Vertices Read`
- `Input Primitives`
- `GS Primitives`
- `Rasterizer Invocations`
- `Rasterized Primitives`
- `Samples Passed`
- `VS Invocations`
- `PS Invocations`
- `CS Invocations`

---

## GPU time
- `gpu__time_duration.sum` (GPU, Counter, unit: nanoseconds) — equals to gpu__time_duration_measured_user if collectable, otherwise equals to gpu__time_duration_measured_wallclock
- `gpu__time_active.sum` (GPU, Counter, unit: nanoseconds) — total duration in nanoseconds

## Shader instructions
- `sm__inst_executed.sum` (SM, Counter, unit: instructions) — # of warp instructions executed
- `smsp__inst_executed_shader_vs.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by VS
- `smsp__inst_executed_shader_tcs.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by TCS
- `smsp__inst_executed_shader_tes.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by TES
- `smsp__inst_executed_shader_gs.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by GS
- `smsp__inst_executed_shader_ps.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by PS
- `smsp__inst_executed_shader_cs.sum` (SMSP, Counter, unit: instructions) — # of warp instructions executed by CS

## Memory traffic (DRAM)
- `dram__bytes_op_read.sum` (DRAM, Counter, unit: bytes) — # of bytes read from DRAM
- `dram__bytes_op_write.sum` (DRAM, Counter, unit: bytes) — # of bytes written to DRAM
- `dram__sectors_op_read.sum` (DRAM, Counter, unit: l2_sectors) — # of sectors read from DRAM
- `dram__sectors_op_write.sum` (DRAM, Counter, unit: l2_sectors) — # of sectors written to DRAM

## Cache hit rates
- `l1tex__t_sector_hit_rate.avg.pct` (L1TEX, Ratio, unit: unitless) — # of sector hits per sector
- `lts__t_sector_hit_rate.avg.pct` (L2 Cache, Ratio, unit: unitless) — proportion of L2 sector lookups that hit

## Warp stall breakdown
- `smsp__warp_issue_stalled_barrier_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for sibling warps at a CTA barrier
- `smsp__warp_issue_stalled_branch_resolving_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a branch target address to be computed, and the warp PC to be updated
- `smsp__warp_issue_stalled_dispatch_stall_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting on a dispatch stall
- `smsp__warp_issue_stalled_drain_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting after EXIT for all memory instructions to complete so that warp resources can be freed
- `smsp__warp_issue_stalled_lg_throttle_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a free entry in the LSU instruction queue
- `smsp__warp_issue_stalled_long_scoreboard_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a scoreboard dependency on L1TEX (local, global, surface, tex) operation
- `smsp__warp_issue_stalled_long_scoreboard_pipe_l1tex_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a scoreboard dependency on non-RTCORE L1TEX (local, global, surface, tex) operation
- `smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for an execution pipe to be available
- `smsp__warp_issue_stalled_membar_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting on a memory barrier
- `smsp__warp_issue_stalled_mio_throttle_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a free entry in the MIO instruction queue
- `smsp__warp_issue_stalled_mio_throttle_pipe_mio_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a free entry in the non-RTCORE pipe of MIO instruction queue
- `smsp__warp_issue_stalled_misc_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting on a miscellaneous hardware reason
- `smsp__warp_issue_stalled_no_instruction_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting to be selected for instruction fetch, or waiting on an instruction cache miss
- `smsp__warp_issue_stalled_not_selected_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for the microscheduler to select the warp to issue
- `smsp__warp_issue_stalled_selected_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, selected by the microscheduler to issue an instruction
- `smsp__warp_issue_stalled_short_scoreboard_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a scoreboard dependency on MIO operation other than (local, global, surface, tex)
- `smsp__warp_issue_stalled_sleeping_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a nanosleep to expire
- `smsp__warp_issue_stalled_tex_throttle_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting for a free entry in the TEX instruction queue
- `smsp__warp_issue_stalled_wait_per_warp_active.avg.pct` (SMSP, Ratio, unit: unitless) — proportion of warps per cycle, waiting on a fixed latency execution dependency

## Register pressure
- `tpc__average_registers_per_thread_shader_3d.avg.ratio` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for 3D warps
- `tpc__average_registers_per_thread_shader_3d.avg.pct` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for 3D warps
- `tpc__average_registers_per_thread_shader_ps.avg.ratio` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for PS warps
- `tpc__average_registers_per_thread_shader_ps.avg.pct` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for PS warps
- `tpc__average_registers_per_thread_shader_vtg.avg.ratio` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for VTG warps
- `tpc__average_registers_per_thread_shader_vtg.avg.pct` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for VTG warps
- `tpc__average_registers_per_thread_shader_cs.avg.ratio` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for CS warps
- `tpc__average_registers_per_thread_shader_cs.avg.pct` (TPC, Ratio, unit: registers / thread) — average # of registers per thread, for CS warps

## Shared memory
- `l1tex__data_pipe_lsu_wavefronts_mem_shared.sum` (L1TEX, Counter, unit: l1tex_wavefronts) — # of shared memory wavefronts processed by Data-Stage for LDS, LD, 3D attribute loads, LDSM, STS, ST, ATOMS, ATOM, 3D attribute stores, STSM, LDGSTS, UMEMSETS and Misc
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_ld.sum` (L1TEX, Counter, unit: l1tex_wavefronts) — # of shared memory wavefronts processed by Data-Stage for LDS, LD, 3D attribute loads, LDSM
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_st.sum` (L1TEX, Counter, unit: l1tex_wavefronts) — # of shared memory wavefronts processed by Data-Stage for STS, ST, 3D attribute stores, STSM
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_atom.sum` (L1TEX, Counter, unit: l1tex_wavefronts) — # of shared memory wavefronts processed by Data-Stage for ATOMS, ATOM
- `l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum` (L1TEX, Counter, unit: l1data_bank_conflicts) — # of shared memory data bank conflicts generated by LDS, LD, 3D attribute loads, LDSM, STS, ST, ATOMS, ATOM, 3D attribute stores, STSM, LDGSTS, UMEMSETS and Misc
- `smsp__bytes_mem_shared_cmd_read.sum` (SMSP, Counter, unit: bytes) — # of bytes requested by LDS, LD and 3D attribute loads
- `smsp__bytes_mem_shared_cmd_atom.sum` (SMSP, Counter, unit: bytes) — # of bytes requested by ATOMS, ATOM

## Backend proxies (CROP/ZROP)
- `crop__read_subpackets.sum` (CROP, Counter, unit: crop_subpackets) — # of subpacket reads of any kind
- `crop__write_subpackets.sum` (CROP, Counter, unit: crop_subpackets) — # of subpacket writes of any kind
- `zrop__read_subpackets.sum` (ZROP, Counter, unit: zrop_subpackets) — # of subpacket reads of any kind
- `zrop__write_subpackets.sum` (ZROP, Counter, unit: zrop_subpackets) — # of subpacket writes of any kind
