# Kai0 浏览器 3D 轨迹查看器

此目录只包含浏览器中的双 Piper 3D 轨迹可视化。它不包含模型推理、训练、开环指标计算或 PNG 绘图代码。

## 清理旧进程，防止占用端口

## 开发机终端
```bash
/pfs/user/view/start_kai0_viewer_in_container.sh --stop
/pfs/user/view/start_kai0_viewer_in_container.sh
```
## 在远程服务器运行时，本地建立隧道：
```bash
ssh -N -L 9002:127.0.0.1:9001 -p 9230 root@113.128.201.98
```
随后访问：`http://127.0.0.1:9002/ee_viewer/index.html`。

轨迹页面顶部提供 `Episode` 和 `Chunk` 两个下拉框，可在同一页面直接切换不同
episode 以及 8/10/32 步结果。服务端默认扫描
`/pfs/user/open_loop_test/results`；如果结果位于其他目录，启动时设置
`KAI0_RESULTS_ROOT=/path/to/results`。


## 更改可视化episode：
只需重新回放新目录的 JSONL；它会自动清空网页中的旧轨迹。在本地 magiclab 执行：
```bash
ssh -p 9230 root@113.128.201.98 \
  'python3 /pfs/user/view/replay_kai0_trajectory.py \
  --viewer-url http://127.0.0.1:9001 --reset-first \
  --input /pfs/user/open_loop_test/results/organize_kitchen_counter_multi_horizon_20260903T034744Z/episode_36/horizon_8/kai0_viewer_replay.jsonl'
```

## 文件说明

- `start_kai0_dual_piper_viewer.sh`：准备双 Piper 网格并启动服务。
- `replay_kai0_trajectory.sh`：将一个 JSONL 回放文件加载到服务。
- `prepare_kai0_robot_viewer.py`：根据 URDF 生成浏览器可读取的网格目录。
- `kai0_viewer_server.py`：静态网页和轨迹 API 服务。
- `replay_kai0_trajectory.py`：JSONL 回放器。
- `kai0_viewer_base/`：Kai0 浏览器前端基础代码，不含任何旧机器人网格。

URDF 更新后，以 `./start_kai0_dual_piper_viewer.sh --rebuild` 重新生成网页资源。



## 开发机终端一：
```bash
cd /pfs/user/view
PYTHON_BIN=python3 ./start_kai0_dual_piper_viewer.sh
```

脚本会从 `/pfs/user/rm-wam/assets/dual_piper/dual_system.urdf` 生成只含双 Piper 网格的静态网页目录 `kai0_dual_piper_viewer/`，然后在 `9001` 端口启动服务。

## 开发机终端二：
```bash
cd /pfs/user/view
./replay_kai0_trajectory.sh /pfs/user/open_loop_test/results/organize_kitchen_counter_multi_horizon_<UTC时间>/episode_36/horizon_8/kai0_viewer_replay.jsonl
```

`replay_kai0_trajectory.sh` 会清空旧会话并推送此次轨迹。网页支持拖动时间滑块，查看预测关节轨迹和 GT 关节轨迹。
