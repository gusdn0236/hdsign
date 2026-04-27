"""분배함 슬롯 좌표 1회용 편집기.

assets/distribution.jpg 위에 hdsign_watcher.SLOT_BOXES 의 박스를 그대로 띄우고
실시간으로 끌어 옮기거나(드래그) 화살표키로 ±1px(±10px with Shift) 미세 조정,
또는 우측 패널의 스핀박스에 직접 입력할 수 있다. EXE 다시 빌드 안 하고 바로 확인.

사용:
    python _slot_editor.py

다 됐으면 [코드 복사] 버튼으로 SLOT_BOXES 블록을 클립보드로 복사하고
hdsign_watcher.py 의 기존 SLOT_BOXES 자리에 그대로 붙여넣으면 끝.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from pathlib import Path

from PIL import Image, ImageTk

# 같은 폴더의 hdsign_watcher 에서 SLOT_BOXES 와 사진 사이즈를 그대로 가져온다.
# hdsign_watcher 는 if __name__ == "__main__" 가드로 보호되어 import 부작용 없음.
from hdsign_watcher import SLOT_BOXES as ORIG_SLOT_BOXES, SLOT_LAYOUT_PHOTO_SIZE


ASSETS_DIR = Path(__file__).resolve().parent / "assets"
PHOTO_PATH = ASSETS_DIR / "distribution.jpg"

# 디스플레이 — 사진이 세로로 길어서(~5613h) height-fit 이 자연스럽다.
DISPLAY_HEIGHT = 800
SRC_W, SRC_H = SLOT_LAYOUT_PHOTO_SIZE
SCALE = DISPLAY_HEIGHT / SRC_H
DISPLAY_WIDTH = int(SRC_W * SCALE)


class SlotEditor:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("분배함 슬롯 좌표 편집기 — distribution.jpg")
        root.geometry(f"{DISPLAY_WIDTH + 380}x{max(DISPLAY_HEIGHT + 60, 720)}")
        root.configure(bg="#fafafa")

        # 작업 데이터: slots[i] = (label, dept, [l, t, r, b]). 박스는 list 로 in-place 수정.
        self.slots: list[tuple[str, str, list[int]]] = [
            (lab, dept, list(box)) for lab, dept, box in ORIG_SLOT_BOXES
        ]
        self.selected_idx: int | None = None
        self.drag_start: tuple[int, int] | None = None
        self.drag_orig: list[int] | None = None
        self._suspend_trace = False

        # ── 좌측: 사진 + 박스 ─────────────────────────────
        canvas_frame = tk.Frame(root, bg="#fafafa")
        canvas_frame.pack(side="left", fill="both", expand=True, padx=10, pady=10)

        self.tk_img = None
        try:
            pil = Image.open(PHOTO_PATH).convert("RGB")
            resample = getattr(Image, "Resampling", Image).LANCZOS
            pil = pil.resize((DISPLAY_WIDTH, DISPLAY_HEIGHT), resample)
            self.tk_img = ImageTk.PhotoImage(pil)
        except Exception as e:
            tk.Label(
                canvas_frame, text=f"사진 로드 실패\n({PHOTO_PATH})\n{e}",
                bg="#fafafa", fg="#dc2626",
                font=("맑은 고딕", 10), justify="left",
            ).pack(pady=20)

        self.canvas = tk.Canvas(
            canvas_frame, width=DISPLAY_WIDTH, height=DISPLAY_HEIGHT,
            bg="#ffffff", highlightthickness=1, highlightbackground="#e4e4e7",
            cursor="crosshair", takefocus=True,
        )
        self.canvas.pack()
        if self.tk_img is not None:
            self.canvas.create_image(0, 0, image=self.tk_img, anchor="nw")

        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Key>", self._on_key)

        # ── 우측: 컨트롤 패널 ─────────────────────────────
        side = tk.Frame(root, width=360, bg="#fafafa")
        side.pack(side="right", fill="y", padx=(0, 10), pady=10)
        side.pack_propagate(False)

        tk.Label(
            side, text="슬롯 좌표 편집기",
            bg="#fafafa", fg="#18181b",
            font=("맑은 고딕", 14, "bold"), anchor="w",
        ).pack(fill="x")
        tk.Label(
            side,
            text=("• 박스 클릭 → 선택  (안에서 드래그하면 이동)\n"
                  "• 화살표키 → 1px 이동  (Shift+화살표는 10px)\n"
                  "• 스핀박스에 정확한 좌표 직접 입력 가능"),
            bg="#fafafa", fg="#71717a",
            font=("맑은 고딕", 9), justify="left", anchor="w",
        ).pack(fill="x", pady=(4, 12))

        self.label_var = tk.StringVar(value="(선택된 슬롯 없음)")
        tk.Label(
            side, textvariable=self.label_var,
            bg="#fafafa", fg="#16a34a",
            font=("맑은 고딕", 11, "bold"),
            wraplength=340, justify="left", anchor="w",
        ).pack(fill="x", pady=(0, 8))

        # 좌표 4개 스핀박스
        coords = tk.Frame(side, bg="#fafafa")
        coords.pack(fill="x", pady=(0, 12))

        self.coord_vars: list[tk.IntVar] = []
        for i, name in enumerate(["Left", "Top", "Right", "Bottom"]):
            row = tk.Frame(coords, bg="#fafafa")
            row.pack(fill="x", pady=2)
            tk.Label(row, text=name, bg="#fafafa", fg="#3f3f46",
                     font=("맑은 고딕", 10), width=8, anchor="w").pack(side="left")
            v = tk.IntVar(value=0)
            tk.Spinbox(
                row, from_=0, to=max(SRC_W, SRC_H), increment=1,
                textvariable=v, width=10, font=("맑은 고딕", 11),
                command=lambda idx=i: self._on_coord_changed(idx),
            ).pack(side="left", padx=(8, 0))
            v.trace_add("write", lambda *a, idx=i: self._on_coord_changed(idx))
            self.coord_vars.append(v)

        # 빠른 선택 콤보
        tk.Label(side, text="슬롯 점프", bg="#fafafa", fg="#3f3f46",
                 font=("맑은 고딕", 9), anchor="w").pack(fill="x", pady=(4, 2))
        self.jump_combo = ttk.Combobox(
            side, state="readonly", font=("맑은 고딕", 10),
            values=[f"{i + 1:>2}. {self.slots[i][0]}" for i in range(len(self.slots))],
        )
        self.jump_combo.pack(fill="x", pady=(0, 12))
        self.jump_combo.bind(
            "<<ComboboxSelected>>",
            lambda _e: self._select(self.jump_combo.current()),
        )

        # 버튼들
        btn_row = tk.Frame(side, bg="#fafafa")
        btn_row.pack(fill="x", pady=4)
        tk.Button(
            btn_row, text="📋 코드 복사", command=self._copy_code,
            bg="#16a34a", fg="white",
            activebackground="#15803d", activeforeground="white",
            font=("맑은 고딕", 10, "bold"),
            relief="flat", padx=12, pady=8, cursor="hand2", bd=0,
        ).pack(side="left", fill="x", expand=True)
        tk.Button(
            btn_row, text="처음으로", command=self._reset,
            bg="#f4f4f5", fg="#3f3f46",
            font=("맑은 고딕", 10),
            relief="flat", padx=12, pady=8, cursor="hand2", bd=0,
        ).pack(side="left", padx=(8, 0))

        self.status_var = tk.StringVar(value="준비됨 — 박스를 클릭해 시작하세요.")
        tk.Label(
            side, textvariable=self.status_var,
            bg="#fafafa", fg="#71717a",
            font=("맑은 고딕", 9), wraplength=340,
            anchor="w", justify="left",
        ).pack(fill="x", pady=(20, 0))

        self._redraw()
        self.canvas.focus_set()

    # ── 좌표 변환 ─────────────────────────────────────
    def _src_to_disp(self, x: int, y: int) -> tuple[float, float]:
        return x * SCALE, y * SCALE

    def _disp_to_src(self, x: float, y: float) -> tuple[int, int]:
        return int(round(x / SCALE)), int(round(y / SCALE))

    # ── 그리기 ────────────────────────────────────────
    def _redraw(self) -> None:
        self.canvas.delete("slot")
        for idx, (_label, dept, box) in enumerate(self.slots):
            l, t, r, b = box
            dl, dt = self._src_to_disp(l, t)
            dr, db = self._src_to_disp(r, b)
            is_selected = idx == self.selected_idx
            outline = "#dc2626" if is_selected else ("#16a34a" if dept else "#94a3b8")
            width = 3 if is_selected else 2
            self.canvas.create_rectangle(
                dl, dt, dr, db,
                outline=outline, width=width,
                tags=("slot",),
            )
            cx = (dl + dr) / 2
            cy = (dt + db) / 2
            self.canvas.create_text(
                cx, cy, text=str(idx + 1),
                fill=outline, font=("맑은 고딕", 12, "bold"),
                tags=("slot",),
            )

    # ── 선택 ───────────────────────────────────────────
    def _select(self, idx: int | None) -> None:
        self.selected_idx = idx
        if idx is None:
            self.label_var.set("(선택된 슬롯 없음)")
            self._suspend_trace = True
            for v in self.coord_vars:
                v.set(0)
            self._suspend_trace = False
            self._redraw()
            return
        label, dept, box = self.slots[idx]
        dept_disp = dept if dept else "(비활성)"
        self.label_var.set(f"#{idx + 1}  {label}\n→  {dept_disp}")
        self._suspend_trace = True
        for i in range(4):
            self.coord_vars[i].set(box[i])
        self._suspend_trace = False
        try:
            self.jump_combo.current(idx)
        except Exception:
            pass
        self._redraw()

    # ── 캔버스 클릭/드래그 ─────────────────────────────
    def _hit_test(self, x_disp: float, y_disp: float) -> int | None:
        x_src, y_src = self._disp_to_src(x_disp, y_disp)
        # 겹친 경우 면적이 가장 작은 박스(=안쪽) 우선.
        best_idx: int | None = None
        best_area: int | None = None
        for idx, (_, _, box) in enumerate(self.slots):
            l, t, r, b = box
            if l <= x_src <= r and t <= y_src <= b:
                area = (r - l) * (b - t)
                if best_area is None or area < best_area:
                    best_idx = idx
                    best_area = area
        return best_idx

    def _on_click(self, e) -> None:
        self.canvas.focus_set()
        idx = self._hit_test(e.x, e.y)
        self._select(idx)
        if idx is not None:
            self.drag_start = (e.x, e.y)
            self.drag_orig = list(self.slots[idx][2])
        else:
            self.drag_start = None
            self.drag_orig = None

    def _on_drag(self, e) -> None:
        if self.selected_idx is None or self.drag_start is None or self.drag_orig is None:
            return
        dx_disp = e.x - self.drag_start[0]
        dy_disp = e.y - self.drag_start[1]
        dx_src = int(round(dx_disp / SCALE))
        dy_src = int(round(dy_disp / SCALE))
        l0, t0, r0, b0 = self.drag_orig
        new_box = [l0 + dx_src, t0 + dy_src, r0 + dx_src, b0 + dy_src]
        new_box = self._clamp_box(new_box)
        self._set_slot_box(self.selected_idx, new_box)
        self._sync_spinboxes(new_box)
        self._redraw()
        self.status_var.set(f"드래그 이동: ({dx_src:+}px, {dy_src:+}px)")

    def _on_release(self, _e) -> None:
        self.drag_start = None
        self.drag_orig = None

    def _clamp_box(self, box: list[int]) -> list[int]:
        l, t, r, b = box
        w = r - l
        h = b - t
        l = max(0, min(SRC_W - w, l))
        t = max(0, min(SRC_H - h, t))
        return [l, t, l + w, t + h]

    def _set_slot_box(self, idx: int, box: list[int]) -> None:
        label, dept, _old = self.slots[idx]
        self.slots[idx] = (label, dept, list(box))

    def _sync_spinboxes(self, box: list[int]) -> None:
        self._suspend_trace = True
        for i in range(4):
            self.coord_vars[i].set(box[i])
        self._suspend_trace = False

    # ── 키보드 ─────────────────────────────────────────
    def _on_key(self, e) -> None:
        if self.selected_idx is None:
            return
        step = 10 if (e.state & 0x0001) else 1  # Shift mask
        dx = dy = 0
        if e.keysym == "Left":
            dx = -step
        elif e.keysym == "Right":
            dx = step
        elif e.keysym == "Up":
            dy = -step
        elif e.keysym == "Down":
            dy = step
        else:
            return
        l, t, r, b = self.slots[self.selected_idx][2]
        new_box = self._clamp_box([l + dx, t + dy, r + dx, b + dy])
        self._set_slot_box(self.selected_idx, new_box)
        self._sync_spinboxes(new_box)
        self._redraw()
        self.status_var.set(f"키보드 이동: ({dx:+}, {dy:+})")

    # ── 스핀박스 직접 입력 ────────────────────────────
    def _on_coord_changed(self, idx_coord: int) -> None:
        if self._suspend_trace or self.selected_idx is None:
            return
        try:
            v = int(self.coord_vars[idx_coord].get())
        except (ValueError, tk.TclError):
            return
        cur = list(self.slots[self.selected_idx][2])
        cur[idx_coord] = v
        # 클램프 — 너비/높이 보존이 아니라 그냥 사진 안으로만 제한.
        l, t, r, b = cur
        l = max(0, min(SRC_W, l))
        r = max(0, min(SRC_W, r))
        t = max(0, min(SRC_H, t))
        b = max(0, min(SRC_H, b))
        if r < l:
            r = l
        if b < t:
            b = t
        cur = [l, t, r, b]
        self._set_slot_box(self.selected_idx, cur)
        self._redraw()
        names = ["Left", "Top", "Right", "Bottom"]
        self.status_var.set(f"좌표 입력: {names[idx_coord]} = {v}")

    # ── 코드 복사 / 초기화 ────────────────────────────
    def _format_code(self) -> str:
        lines = [
            "SLOT_BOXES: list[tuple[str, str, tuple[int, int, int, int]]] = ["
        ]
        for label, dept, box in self.slots:
            l, t, r, b = box
            lines.append(f'    ("{label}", "{dept}", ({l}, {t}, {r}, {b})),')
        lines.append("]")
        return "\n".join(lines)

    def _copy_code(self) -> None:
        code = self._format_code()
        self.root.clipboard_clear()
        self.root.clipboard_append(code)
        # 일부 OS 에서 update() 안 해주면 클립보드가 자기 프로세스에 머물러 다른 앱에 안 보임.
        self.root.update()
        self.status_var.set("✓ 클립보드 복사 완료 — hdsign_watcher.py 의 SLOT_BOXES 자리에 붙여넣으세요.")

    def _reset(self) -> None:
        self.slots = [(lab, dept, list(box)) for lab, dept, box in ORIG_SLOT_BOXES]
        if self.selected_idx is not None:
            self._sync_spinboxes(self.slots[self.selected_idx][2])
        self._redraw()
        self.status_var.set("처음 값(hdsign_watcher.SLOT_BOXES) 으로 되돌렸습니다.")


if __name__ == "__main__":
    root = tk.Tk()
    SlotEditor(root)
    root.mainloop()
