# BoundDetectorAdvanced — RenderDoc metrics pack (extended)

## Generic (RenderDoc pipeline stats)
  - `GPU Duration` / `GPU Duration (ms)`
  - `Samples Passed`
  - `VS Invocations` / `PS Invocations` / `CS Invocations`
  - `Input Vertices Read` / `Input Primitives` / `GS Primitives`
  - `Rasterizer Invocations` / `Rasterized Primitives`

## Time
- `gpu__time_active.avg`
- `gpu__time_active.sum`
- `gpu__time_duration.avg`
- `gpu__time_duration.sum`

## Shader instructions
- `sm__inst_executed.avg`
- `sm__inst_executed.sum`
- `smsp__inst_executed_shader_cs.sum`
- `smsp__inst_executed_shader_gs.sum`
- `smsp__inst_executed_shader_ps.sum`
- `smsp__inst_executed_shader_tcs.sum`
- `smsp__inst_executed_shader_tes.sum`
- `smsp__inst_executed_shader_vs.sum`

## Memory traffic (DRAM)
- `dram__bytes_op_read.avg`
- `dram__bytes_op_read.sum`
- `dram__bytes_op_write.avg`
- `dram__bytes_op_write.sum`
- `dram__sectors_op_read.sum`
- `dram__sectors_op_write.sum`

## Cache hit (L1 / Texture)
- `l1tex__average_t_sector_lookup_hit.avg.pct`
- `l1tex__average_t_sector_lookup_hit.avg.ratio`
- `l1tex__t_sector_hit_rate.avg.pct`
- `l1tex__t_sector_hit_rate.avg.ratio`
- `l1tex__t_sector_pipe_tex_hit_rate.avg.pct`
- `l1tex__t_sector_pipe_tex_hit_rate.avg.ratio`
- `l1tex__t_sector_pipe_tex_mem_texture_hit_rate.avg.pct`
- `l1tex__t_sector_pipe_tex_mem_texture_hit_rate.avg.ratio`

## Cache hit (L2)
- `lts__average_t_sector_hit_rate_realtime.avg.pct`
- `lts__average_t_sector_hit_rate_realtime.avg.ratio`
- `lts__t_sector_hit_rate.avg.pct`
- `lts__t_sector_hit_rate.avg.ratio`

## Warp stalls
- `smsp__warp_issue_stalled_barrier_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_barrier_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_branch_resolving_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_branch_resolving_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_dispatch_stall_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_dispatch_stall_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_drain_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_drain_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_lg_throttle_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_lg_throttle_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_long_scoreboard_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_long_scoreboard_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_long_scoreboard_pipe_l1tex_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_long_scoreboard_pipe_l1tex_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_membar_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_membar_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_mio_throttle_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_mio_throttle_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_mio_throttle_pipe_mio_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_mio_throttle_pipe_mio_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_misc_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_misc_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_no_instruction_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_no_instruction_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_not_selected_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_not_selected_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_selected_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_selected_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_short_scoreboard_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_short_scoreboard_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_sleeping_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_sleeping_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_tex_throttle_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_tex_throttle_per_warp_active.avg.ratio`
- `smsp__warp_issue_stalled_wait_per_warp_active.avg.pct`
- `smsp__warp_issue_stalled_wait_per_warp_active.avg.ratio`

## Register pressure / occupancy
- `tpc__average_registers_per_thread_shader_3d.avg.pct`
- `tpc__average_registers_per_thread_shader_3d.avg.ratio`
- `tpc__average_registers_per_thread_shader_cs.avg.pct`
- `tpc__average_registers_per_thread_shader_cs.avg.ratio`
- `tpc__average_registers_per_thread_shader_ps.avg.pct`
- `tpc__average_registers_per_thread_shader_ps.avg.ratio`
- `tpc__average_registers_per_thread_shader_vtg.avg.pct`
- `tpc__average_registers_per_thread_shader_vtg.avg.ratio`

## Shared memory
- `l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum`
- `l1tex__data_pipe_lsu_wavefronts_mem_shared.sum`
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_atom.sum`
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_ld.sum`
- `l1tex__data_pipe_lsu_wavefronts_mem_shared_op_st.sum`
- `smsp__bytes_mem_shared_cmd_atom.sum`
- `smsp__bytes_mem_shared_cmd_read.sum`

## Backend output (CROP/ZROP)
- `crop__read_subpackets.sum`
- `crop__write_subpackets.sum`
- `zrop__read_subpackets.sum`
- `zrop__write_subpackets.sum`
