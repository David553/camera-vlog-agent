# camera-vlog-agent

把家庭 RTSP 摄像头的画面变成**自动打标签、自动剪辑的 vlog**。基于 [pi-agent-core](https://github.com/badlogic/pi-mono) 的本地 agent：录制、运动分析、剪辑决策编排、ffmpeg 合成全部在本地运行，只有文本推理和关键帧打标调用云端模型。

```
RTSP 摄像头 → go2rtc(仅回环) → ffmpeg 分段录制 → OpenCV 运动分析(本地，静止段零上传)
   → pi-agent(文本大脑) 编排工具
       → tag_clip: 上传 ≤2 张关键帧给视觉模型 → 标签+描述
       → build_vlog: 每段取最长运动窗口精剪 + 中文字幕卡 + 淡入淡出 + 片头片尾
   → vlogs/*.mp4
```

## 特性

- 一条命令端到端：录制 → 打标 → 剪辑成片
- 本地运动过滤：静止片段不上传任何画面，省 token
- 视觉打标兼容任意 OpenAI 兼容视觉模型（如百炼 qwen3-vl-plus）；未配置时降级为文本推断标签并如实标记 `provisional=true`
- 真剪辑：高光窗口截取、标签字幕卡、画面描述字幕、转场淡化、片头片尾
- 云端上传台账 `logs/cloud-calls.json`：每次运行披露上传了哪些帧
- `--edit-only`：不录制，对已有片段重打标签/重剪

## 前置条件

- Windows 10/11（`run.cmd` 与中文字体 msyh.ttc 依赖 Windows）
- Node.js ≥ 24（直接运行 .ts，无需构建）
- Python 3 + `opencv-python`、`numpy`
- ffmpeg（含 libx264 / drawtext）、[go2rtc](https://github.com/AlexxIT/go2rtc)
- 一个 RTSP 摄像头或其他 RTSP 源
- OpenAI 兼容文本模型 API key（agent 大脑）；视觉模型 key 可选

## 快速开始

```bash
git clone https://github.com/David553/camera-vlog-agent.git
cd camera-vlog-agent
npm install
pip install opencv-python numpy
copy .env.example .env        # 填 AGENT_*，VISION_* 可选
copy go2rtc.example.yaml go2rtc.yaml   # 改成你的摄像头地址/密码，保留 #transport=tcp
```

ffmpeg / go2rtc 放进 PATH，或在 `.env` 里填 `FFMPEG_PATH` / `GO2RTC_PATH`；
已有 opencv 的 site-packages 目录可填 `PYTHON_PACKAGES`，否则用系统 python 环境。

双击 `run.cmd`，或：

```bash
node --env-file=.env src/main.ts            # 默认录 60s
node --env-file=.env src/main.ts --seconds 120
node --env-file=.env src/main.ts --edit-only
```

成片在 `vlogs/`，片段与标签在 `clips/` + `index.json`。

## agent 决策逻辑

三层分工：

1. **质量层（本地确定性代码）**：OpenCV 帧差运动阈值决定哪些段值得打标；`activeWindows` 运动区间决定每段剪哪几秒（取最长活跃窗口）。
2. **语义层（云端视觉模型，工具内一次性调用）**：关键帧 → 严格 JSON 标签+描述。
3. **编排层（pi-agent 循环，文本大脑）**：按 system prompt 决定工具调用顺序，可用 `tag` / `max_clips` 参数选片。

## 隐私与安全

- go2rtc 全部监听 `127.0.0.1`。**不要把摄像头 554 端口暴露到公网，不要开 DMZ。**
- 只有运动段的关键帧会上传到你配置的视觉模型；上传台账可审计。
- `.env`、`go2rtc.yaml`、所有视频/帧/日志目录均在 `.gitignore` 中，不入库。

## 成本参考

qwen3-vl-plus 每次打标约 330 token（2 张关键帧）；阿里云百炼新用户有 1M token 免费额度。静止场景零云端调用。

## License

MIT