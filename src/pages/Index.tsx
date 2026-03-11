import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import PatternGrid, { Selection, normalizeSelection, Guidelines } from "@/components/PatternGrid";
import { YARN_COLORS } from "@/components/ColorPalette";
import AppSidebar from "@/components/AppSidebar";
import { CellData, getStitchSpan, getStitchNetChange, STITCH_SYMBOLS } from "@/lib/stitchSymbols";
import { drawStitchOnCanvas, STITCH_ICON_MAP } from "@/components/StitchIcons";
import { PatternNotesData, loadNotes, persistNotes, EMPTY_NOTES } from "@/components/PatternNotes";
import { useHistory } from "@/hooks/useHistory";
import {
  Undo2, Redo2, Copy, ClipboardPaste, BoxSelect,
  FlipHorizontal2, FlipVertical2, PaintBucket, Pencil,
  ZoomIn, ZoomOut,
  MousePointer2, Eraser, Sun, Moon, Grid3X3, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { toast } from "@/hooks/use-toast";
import { WelcomeDialog, HelpButton } from "@/components/HelpDialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

import { useTheme } from "next-themes";
import jsPDF from "jspdf";

const DEFAULT_BG = "#F5F0EB";
const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 20;

function createEmptyCell(): CellData {
  return { color: DEFAULT_BG, stitchId: "knit" };
}

function createGrid(rows: number, cols: number): CellData[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => createEmptyCell())
  );
}

/** Clear any span ownership from cells that were part of a multi-cell stitch starting at (row, ownerCol) */
function clearSpan(grid: CellData[][], row: number, col: number) {
  const rowData = grid[row];
  if (!rowData || col < 0 || col >= rowData.length) return;

  const cell = rowData[col];
  if (!cell) return;

  const span = Math.max(1, getStitchSpan(cell.stitchId));
  for (let i = 0; i < span && col + i < rowData.length; i++) {
    rowData[col + i] = createEmptyCell();
  }
}

/** Place a stitch (possibly multi-cell) at a position */
function placeStitch(
  grid: CellData[][],
  row: number,
  col: number,
  stitchId: string,
  color: string
): boolean {
  const rowData = grid[row];
  if (!rowData || col < 0 || col >= rowData.length) return false;

  const span = getStitchSpan(stitchId);

  // Check if we have room
  if (col + span > rowData.length) return false;

  // Clear any existing spans that overlap
  for (let i = 0; i < span; i++) {
    const existing = rowData[col + i];
    if (!existing) continue;

    // If this cell is owned by a span, clear that span first
    if (existing.spanOwner !== undefined) {
      clearSpan(grid, row, existing.spanOwner);
    } else if (getStitchSpan(existing.stitchId) > 1) {
      clearSpan(grid, row, col + i);
    }
  }

  // Place the stitch
  rowData[col] = { color, stitchId, spanOwner: span > 1 ? col : undefined };
  for (let i = 1; i < span; i++) {
    rowData[col + i] = { color, stitchId: "none", spanOwner: col };
  }

  return true;
}

const Index = () => {
  const { t } = useTranslation();
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [cols, setCols] = useState(DEFAULT_COLS);
  const {
    state: grid, set: setGrid, setSilent, beginBatch, commitBatch,
    undo, redo, canUndo, canRedo,
  } = useHistory(createGrid(DEFAULT_ROWS, DEFAULT_COLS));
  const [selectedColor, setSelectedColor] = useState(YARN_COLORS[1].value);
  const [selectedStitch, setSelectedStitch] = useState("knit");
  const isDragging = useRef(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [clipboard, setClipboard] = useState<CellData[][] | null>(null);
  const [cursorCell, setCursorCell] = useState<{ row: number; col: number } | null>(null);
  const [mirrorH, setMirrorH] = useState(false);
  const [mirrorV, setMirrorV] = useState(false);
  const [activeTool, setActiveTool] = useState<"paint" | "fill" | "select" | "eraser">("paint");
  const [zoom, setZoom] = useState(1);
  const { theme, setTheme } = useTheme();
  const [patternNotes, setPatternNotes] = useState<PatternNotesData>(loadNotes);
  const [patternName, setPatternName] = useState("");
  const [guidelines, setGuidelines] = useState<Guidelines>({ rows: [], cols: [] });

  const floodFill = useCallback(
    (startRow: number, startCol: number) => {
      setGrid((prev) => {
        const targetColor = prev[startRow]?.[startCol]?.color;
        const targetStitch = prev[startRow]?.[startCol]?.stitchId;
        if (targetColor === selectedColor && targetStitch === selectedStitch) return prev;

        const next = prev.map((r) => r.map((c) => ({ ...c })));
        const numRows = next.length;
        const numCols = next[0]?.length ?? 0;
        const visited = new Set<string>();
        const queue: [number, number][] = [[startRow, startCol]];

        while (queue.length > 0) {
          const [r, c] = queue.shift()!;
          const key = `${r},${c}`;
          if (visited.has(key)) continue;
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;
          const cell = next[r][c];
          if (cell.color !== targetColor || cell.stitchId !== targetStitch) continue;
          visited.add(key);
          next[r][c] = { ...cell, color: selectedColor, stitchId: selectedStitch };
          queue.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
        }
        return next;
      });
    },
    [selectedColor, selectedStitch, setGrid]
  );

  /** Apply shaping: walk bottom-to-top, compute expected stitch count per row,
   *  then rebuild each row with centered active stitches and no-stitch padding at edges. */
  const applyShaping = useCallback(() => {
    setGrid((prev) => {
      const numRows = prev.length;
      if (numRows === 0) return prev;

      // For each row: extract active cells, track net change and shaping position bias
      const rowInfo = prev.map((row) => {
        const activeCells: CellData[] = [];
        const oldColToActive = new Map<number, number>();
        let netChange = 0;
        let colIdx = 0;
        let leftShaping = 0;
        let rightShaping = 0;
        const mid = row.length / 2;

        while (colIdx < row.length) {
          const cell = row[colIdx];
          if (cell.spanOwner !== undefined && cell.spanOwner !== colIdx) {
            colIdx++;
            continue;
          }
          const span = Math.max(1, getStitchSpan(cell.stitchId));
          const nc = getStitchNetChange(cell.stitchId);
          netChange += nc;

          // Track which side shaping stitches are on
          if (nc !== 0) {
            if (colIdx < mid) leftShaping += Math.abs(nc);
            else rightShaping += Math.abs(nc);
          }

          if (cell.stitchId !== "none") {
            for (let s = 0; s < span && colIdx + s < row.length; s++) {
              oldColToActive.set(colIdx + s, activeCells.length);
              activeCells.push({ ...row[colIdx + s] });
            }
          }
          colIdx += span;
        }

        const totalShaping = leftShaping + rightShaping;
        // -1 = all shaping on left, 0 = centered, 1 = all on right
        const shapingBias = totalShaping === 0 ? 0 : (rightShaping - leftShaping) / totalShaping;

        return { activeCells, oldColToActive, netChange, cellCount: activeCells.length, shapingBias };
      });

      // Expected counts: bottom row is baseline (no adjustment), propagate upward
      const expectedCounts = new Array(numRows);
      expectedCounts[numRows - 1] = rowInfo[numRows - 1].cellCount;
      let maxWidth = expectedCounts[numRows - 1];

      for (let i = numRows - 2; i >= 0; i--) {
        expectedCounts[i] = expectedCounts[i + 1] + rowInfo[i].netChange;
        maxWidth = Math.max(maxWidth, expectedCounts[i]);
      }

      // Idempotency: skip if all rows already match expected counts
      let alreadyApplied = true;
      for (let i = 0; i < numRows; i++) {
        if (rowInfo[i].cellCount !== expectedCounts[i]) {
          alreadyApplied = false;
          break;
        }
      }
      if (alreadyApplied) {
        return prev;
      }

      const currentCols = prev[0]?.length ?? 0;
      const totalCols = Math.max(currentCols, maxWidth);
      const noStitch = (): CellData => ({ color: DEFAULT_BG, stitchId: "none" });

      // Calculate cumulative bias: propagate from rows with shaping upward
      const biases = new Array(numRows).fill(0);
      let lastBias = 0;
      for (let i = numRows - 1; i >= 0; i--) {
        if (rowInfo[i].netChange !== 0) {
          lastBias = rowInfo[i].shapingBias;
        }
        biases[i] = lastBias;
      }

      // Rebuild each row with asymmetric padding/trimming
      const next = prev.map((row, rowIdx) => {
        const { activeCells, oldColToActive } = rowInfo[rowIdx];
        const expected = expectedCounts[rowIdx];
        const bias = biases[rowIdx];

        let usedCells = activeCells;
        let usedOldColToActive = oldColToActive;
        if (activeCells.length > expected) {
          const excess = activeCells.length - expected;
          // bias: -1 → trim from left, 1 → trim from right, 0 → centered
          const trimRight = Math.round(excess * ((1 + bias) / 2));
          const trimLeft = excess - trimRight;
          usedCells = activeCells.slice(trimLeft, activeCells.length - trimRight || undefined);
          usedOldColToActive = new Map<number, number>();
          for (const [oldCol, activeIdx] of oldColToActive.entries()) {
            const newIdx = activeIdx - trimLeft;
            if (newIdx >= 0 && newIdx < usedCells.length) {
              usedOldColToActive.set(oldCol, newIdx);
            }
          }
        }

        const fillerCount = Math.max(0, expected - usedCells.length);
        // bias: -1 → fill on left, 1 → fill on right
        const fillerLeft = Math.round(fillerCount * ((1 - bias) / 2));
        const fillerRight = fillerCount - fillerLeft;

        const contentCells: CellData[] = [];
        for (let i = 0; i < fillerLeft; i++) contentCells.push({ color: DEFAULT_BG, stitchId: "knit" });

        const activeOffset = fillerLeft;
        for (let i = 0; i < usedCells.length; i++) {
          const cell = { ...usedCells[i] };
          if (cell.spanOwner !== undefined) {
            const ownerActiveIdx = usedOldColToActive.get(cell.spanOwner);
            cell.spanOwner = ownerActiveIdx !== undefined ? ownerActiveIdx + activeOffset : activeOffset + i;
          }
          contentCells.push(cell);
        }

        for (let i = 0; i < fillerRight; i++) contentCells.push({ color: DEFAULT_BG, stitchId: "knit" });

        // Pad with no-stitch to reach totalCols, biased to the shaping side
        const noStitchPadding = totalCols - contentCells.length;
        const padLeft = Math.round(Math.max(0, noStitchPadding) * ((1 - bias) / 2));
        const padRight = Math.max(0, noStitchPadding) - padLeft;

        const newRow: CellData[] = [];
        for (let i = 0; i < padLeft; i++) newRow.push(noStitch());

        for (let i = 0; i < contentCells.length; i++) {
          const cell = { ...contentCells[i] };
          if (cell.spanOwner !== undefined) cell.spanOwner += padLeft;
          newRow.push(cell);
        }

        for (let i = 0; i < padRight; i++) newRow.push(noStitch());

        return newRow;
      });

      if (totalCols > currentCols) {
        setCols(totalCols);
      }

      return next;
    });
    toast({ title: "Shaping applied", description: "Rows adjusted based on stitch shaping." });
  }, [setGrid, setCols]);

  const handleSelectStart = useCallback((row: number, col: number) => {
    setIsSelecting(true);
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
  }, []);

  const handleSelectMove = useCallback((row: number, col: number) => {
    setSelection((prev) => prev ? { ...prev, endRow: row, endCol: col } : null);
  }, []);

  const handleSelectEnd = useCallback(() => {
    setIsSelecting(false);
  }, []);

  const handleCopy = useCallback(() => {
    if (!selection) return;
    const { minRow, maxRow, minCol, maxCol } = normalizeSelection(selection);
    const copied: CellData[][] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const row: CellData[] = [];
      for (let c = minCol; c <= maxCol; c++) {
        row.push({ ...grid[r][c] });
      }
      copied.push(row);
    }
    setClipboard(copied);
    toast({ title: "Copied", description: `${copied.length}×${copied[0].length} cells copied` });
  }, [selection, grid]);

  const handlePaste = useCallback(() => {
    if (!clipboard || !cursorCell) return;
    setGrid((prev) => {
      const next = prev.map((r) => r.map((c) => ({ ...c })));
      for (let r = 0; r < clipboard.length; r++) {
        for (let c = 0; c < clipboard[0].length; c++) {
          const tr = cursorCell.row + r;
          const tc = cursorCell.col + c;
          if (tr < next.length && tc < (next[0]?.length ?? 0)) {
            next[tr][tc] = { ...clipboard[r][c] };
          }
        }
      }
      return next;
    });
    toast({ title: "Pasted", description: `${clipboard.length}×${clipboard[0].length} cells pasted` });
  }, [clipboard, cursorCell, setGrid]);

  const handleTile = useCallback(() => {
    if (!selection) return;
    const { minRow, maxRow, minCol, maxCol } = normalizeSelection(selection);
    const tileRows = maxRow - minRow + 1;
    const tileCols = maxCol - minCol + 1;

    // Extract the tile
    const tile: CellData[][] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const row: CellData[] = [];
      for (let c = minCol; c <= maxCol; c++) {
        row.push({ ...grid[r][c] });
      }
      tile.push(row);
    }

    setGrid((prev) => {
      const next = prev.map((r) => r.map((c) => ({ ...c })));
      const numRows = next.length;
      const numCols = next[0]?.length ?? 0;
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const srcR = ((r - minRow) % tileRows + tileRows) % tileRows;
          const srcC = ((c - minCol) % tileCols + tileCols) % tileCols;
          next[r][c] = { ...tile[srcR][srcC] };
        }
      }
      return next;
    });

    setSelection(null);
    toast({
      title: "Tiled",
      description: `${tileRows}×${tileCols} pattern repeated across ${rows}×${cols} grid`,
    });
  }, [selection, grid, rows, cols, setGrid]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "y") {
        e.preventDefault();
        redo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        if (selection) {
          e.preventDefault();
          handleCopy();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        if (clipboard && cursorCell) {
          e.preventDefault();
          handlePaste();
        }
      }
      if (e.key === "Escape") {
        setSelection(null);
        setCursorCell(null);
      }
      // Tool switching shortcuts (only when no modifier keys)
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        switch (e.key.toLowerCase()) {
          case "b": setActiveTool("paint"); break;
          case "e": setActiveTool("eraser"); break;
          case "f": setActiveTool("fill"); break;
          case "s": e.preventDefault(); setActiveTool("select"); break;
          case "t": if (selection) handleTile(); break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, selection, handleCopy, clipboard, cursorCell, handlePaste, handleTile]);

  const paintCell = useCallback(
    (row: number, col: number) => {
      if (activeTool === "fill") {
        floodFill(row, col);
        return;
      }

      if (activeTool === "eraser") {
        setGrid((prev) => {
          if (row < 0 || row >= prev.length) return prev;
          const next = prev.map((r) => r.map((c) => ({ ...c })));
          const numRows = next.length;
          const numCols = next[0]?.length ?? 0;
          const eraseOne = (r: number, c: number) => {
            if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
            const cell = next[r][c];
            if (cell.spanOwner !== undefined) clearSpan(next, r, cell.spanOwner);
            else clearSpan(next, r, c);
          };
          eraseOne(row, col);
          if (mirrorH) eraseOne(row, numCols - 1 - col);
          if (mirrorV) eraseOne(numRows - 1 - row, col);
          if (mirrorH && mirrorV) eraseOne(numRows - 1 - row, numCols - 1 - col);
          return next;
        });
        return;
      }

      setGrid((prev) => {
        if (row < 0 || row >= prev.length) return prev;
        const rowData = prev[row];
        if (!rowData || col < 0 || col >= rowData.length) return prev;

        const next = prev.map((r) => r.map((c) => ({ ...c })));
        const numRows = next.length;
        const numCols = next[0]?.length ?? 0;

        const paintOne = (r: number, c: number) => {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
          const cell = next[r]?.[c];
          if (!cell) return;
          const isOwner = cell.spanOwner === undefined || cell.spanOwner === c;
          const isSame = isOwner && cell.stitchId === selectedStitch && cell.color === selectedColor;
          if (isSame) {
            clearSpan(next, r, c);
          } else {
            if (cell.spanOwner !== undefined && cell.spanOwner !== c) {
              clearSpan(next, r, cell.spanOwner);
            }
            placeStitch(next, r, c, selectedStitch, selectedColor);
          }
        };

        paintOne(row, col);
        if (mirrorH) paintOne(row, numCols - 1 - col);
        if (mirrorV) paintOne(numRows - 1 - row, col);
        if (mirrorH && mirrorV) paintOne(numRows - 1 - row, numCols - 1 - col);

        return next;
      });
    },
    [selectedColor, selectedStitch, setGrid, mirrorH, mirrorV, activeTool, floodFill]
  );

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    beginBatch();
  }, [beginBatch]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    commitBatch();
  }, [commitBatch]);

  const handleCellDrag = useCallback(
    (row: number, col: number) => {
      if (!isDragging.current) return;
      if (activeTool === "fill") return;
      const rowData = grid[row];
      if (!rowData || col < 0 || col >= rowData.length) return;

      const next = grid.map((r) => r.map((c) => ({ ...c })));
      const numRows = next.length;
      const numCols = next[0]?.length ?? 0;

      if (activeTool === "eraser") {
        const eraseOne = (r: number, c: number) => {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
          const cell = next[r][c];
          if (cell.spanOwner !== undefined) clearSpan(next, r, cell.spanOwner);
          else clearSpan(next, r, c);
        };
        eraseOne(row, col);
        if (mirrorH) eraseOne(row, numCols - 1 - col);
        if (mirrorV) eraseOne(numRows - 1 - row, col);
        if (mirrorH && mirrorV) eraseOne(numRows - 1 - row, numCols - 1 - col);
      } else {
        const paintOne = (r: number, c: number) => {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
          placeStitch(next, r, c, selectedStitch, selectedColor);
        };
        paintOne(row, col);
        if (mirrorH) paintOne(row, numCols - 1 - col);
        if (mirrorV) paintOne(numRows - 1 - row, col);
        if (mirrorH && mirrorV) paintOne(numRows - 1 - row, numCols - 1 - col);
      }

      setSilent(next);
    },
    [selectedColor, selectedStitch, grid, setSilent, mirrorH, mirrorV, activeTool]
  );

  const handleRowsChange = useCallback(
    (newRows: number) => {
      setRows(newRows);
      setGrid((prev) => {
        if (newRows > prev.length) {
          const currentCols = prev[0]?.length ?? cols;
          return [...prev, ...createGrid(newRows - prev.length, currentCols)];
        }
        return prev.slice(0, newRows);
      });
    },
    [cols, setGrid]
  );

  const handleColsChange = useCallback(
    (newCols: number) => {
      setCols(newCols);
      setGrid((prev) =>
        prev.map((row) => {
          if (newCols > row.length) {
            return [
              ...row,
              ...Array.from({ length: newCols - row.length }, () => createEmptyCell()),
            ];
          }
          return row.slice(0, newCols);
        })
      );
    },
    [setGrid]
  );

  const handleClear = useCallback(() => {
    setGrid(createGrid(rows, cols));
    setGuidelines({ rows: [], cols: [] });
  }, [rows, cols, setGrid]);

  const handleLoadPattern = useCallback(
    (loadedGrid: CellData[][], loadedRows: number, loadedCols: number, notes?: PatternNotesData, loadedGuidelines?: Guidelines) => {
      setRows(loadedRows);
      setCols(loadedCols);
      setGrid(loadedGrid);
      setGuidelines(loadedGuidelines || { rows: [], cols: [] });
      if (notes) {
        setPatternNotes(notes);
        persistNotes(notes);
      }
    },
    [setGrid]
  );

  const stitchCount = grid.flat().filter((c) => c && (c.color !== DEFAULT_BG || (c.stitchId !== "none" && c.spanOwner === undefined))).length;

  const handleExport = useCallback(() => {
    const scale = 80;
    const labelSize = Math.ceil(scale * 0.6);
    const padding = 4;
    const margin = Math.ceil(scale * 0.5); // extra whitespace on top and left
    const gridW = cols * scale;
    const gridH = rows * scale;
    const totalW = margin + gridW + labelSize + padding * 2;
    const totalH = margin + gridH + labelSize + padding * 2;

    const canvas = document.createElement("canvas");
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext("2d")!;

    // Background
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, totalW, totalH);

    const isLight = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r * 299 + g * 587 + b * 114) / 1000 > 150;
    };

    const offsetX = margin + padding;
    const offsetY = margin + padding;

    // Column numbers at bottom (right-to-left, knitting convention)
    ctx.fillStyle = "#666";
    ctx.font = `${Math.ceil(scale * 0.35)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let c = 0; c < cols; c++) {
      ctx.fillText(String(cols - c), offsetX + c * scale + scale / 2, offsetY + gridH + 4);
    }

    // Row numbers on right (bottom-to-top, knitting convention)
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let r = 0; r < rows; r++) {
      ctx.fillText(String(rows - r), offsetX + gridW + 4, offsetY + r * scale + scale / 2);
    }

    // Draw all cell backgrounds and grid lines
    grid.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        const isNoStitch = cell.stitchId === "none";
        ctx.fillStyle = isNoStitch ? "#C8C4BE" : cell.color;
        ctx.fillRect(offsetX + ci * scale, offsetY + ri * scale, scale, scale);
        ctx.strokeStyle = "#D0D0D0";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(offsetX + ci * scale, offsetY + ri * scale, scale, scale);
      })
    );

    // Grid border
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(offsetX, offsetY, gridW, gridH);

    // Draw stitch symbols (only for owner cells)
    grid.forEach((row, ri) => {
      let ci = 0;
      while (ci < row.length) {
        const cell = row[ci];
        if (cell.spanOwner !== undefined && cell.spanOwner !== ci) {
          ci++;
          continue;
        }
        const isNoStitch = cell.stitchId === "none";
        if (isNoStitch || (cell.stitchId !== "none" && cell.stitchId !== "knit")) {
          const span = getStitchSpan(cell.stitchId);
          const totalWidth = Math.min(span, row.length - ci) * scale;
          const bgColor = isNoStitch ? "#C8C4BE" : cell.color;
          const symbolColor = isLight(bgColor) ? "#3A3A3A" : "#F5F0EB";
          drawStitchOnCanvas(ctx, cell.stitchId, offsetX + ci * scale, offsetY + ri * scale, scale, symbolColor, totalWidth);
        }
        ci += Math.max(1, getStitchSpan(cell.stitchId));
      }
    });

    // Draw guidelines
    ctx.strokeStyle = "#2E8B57";
    ctx.lineWidth = 3;
    for (const rowIdx of guidelines.rows) {
      const y = offsetY + (rowIdx + 1) * scale;
      ctx.beginPath();
      ctx.moveTo(offsetX, y);
      ctx.lineTo(offsetX + gridW, y);
      ctx.stroke();
    }
    for (const colIdx of guidelines.cols) {
      const x = offsetX + (colIdx + 1) * scale;
      ctx.beginPath();
      ctx.moveTo(x, offsetY);
      ctx.lineTo(x, offsetY + gridH);
      ctx.stroke();
    }

    ctx.fillStyle = "#BBB";
    ctx.font = `${Math.ceil(scale * 0.3)}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("Purl & Plot", totalW - padding, totalH - 2);

    const link = document.createElement("a");
    link.download = "knitting-pattern.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, [grid, rows, cols, guidelines, guidelines]);

  const handleExportPDF = useCallback(() => {
    // Build chart as canvas first (reuse PNG logic at lower scale)
    const scale = 40;
    const labelSize = Math.ceil(scale * 0.6);
    const pad = 4;
    const margin = Math.ceil(scale * 0.5);
    const gridW = cols * scale;
    const gridH = rows * scale;
    const chartW = margin + gridW + labelSize + pad * 2;
    const chartH = margin + gridH + labelSize + pad * 2;

    const canvas = document.createElement("canvas");
    canvas.width = chartW;
    canvas.height = chartH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, chartW, chartH);

    const isLightColor = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r * 299 + g * 587 + b * 114) / 1000 > 150;
    };

    const oX = margin + pad;
    const oY = margin + pad;

    // Col numbers bottom
    ctx.fillStyle = "#666";
    ctx.font = `${Math.ceil(scale * 0.35)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let c = 0; c < cols; c++) ctx.fillText(String(cols - c), oX + c * scale + scale / 2, oY + gridH + 4);
    // Row numbers right
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let r = 0; r < rows; r++) ctx.fillText(String(rows - r), oX + gridW + 4, oY + r * scale + scale / 2);

    grid.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        const isNo = cell.stitchId === "none";
        ctx.fillStyle = isNo ? "#C8C4BE" : cell.color;
        ctx.fillRect(oX + ci * scale, oY + ri * scale, scale, scale);
        ctx.strokeStyle = "#D0D0D0";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(oX + ci * scale, oY + ri * scale, scale, scale);
      })
    );
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(oX, oY, gridW, gridH);

    grid.forEach((row, ri) => {
      let ci = 0;
      while (ci < row.length) {
        const cell = row[ci];
        if (cell.spanOwner !== undefined && cell.spanOwner !== ci) { ci++; continue; }
        const isNo = cell.stitchId === "none";
        if (isNo || (cell.stitchId !== "none" && cell.stitchId !== "knit")) {
          const span = getStitchSpan(cell.stitchId);
          const tw = Math.min(span, row.length - ci) * scale;
          const bg = isNo ? "#C8C4BE" : cell.color;
          const sc = isLightColor(bg) ? "#3A3A3A" : "#F5F0EB";
          drawStitchOnCanvas(ctx, cell.stitchId, oX + ci * scale, oY + ri * scale, scale, sc, tw);
        }
        ci += Math.max(1, getStitchSpan(cell.stitchId));
      }
    });

    // Draw guidelines on PDF canvas
    ctx.strokeStyle = "#2E8B57";
    ctx.lineWidth = 2;
    for (const rowIdx of guidelines.rows) {
      const y = oY + (rowIdx + 1) * scale;
      ctx.beginPath();
      ctx.moveTo(oX, y);
      ctx.lineTo(oX + gridW, y);
      ctx.stroke();
    }
    for (const colIdx of guidelines.cols) {
      const x = oX + (colIdx + 1) * scale;
      ctx.beginPath();
      ctx.moveTo(x, oY);
      ctx.lineTo(x, oY + gridH);
      ctx.stroke();
    }

    // Build PDF
    const pdf = new jsPDF({ orientation: chartW > chartH ? "landscape" : "portrait", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const pdfMargin = 40;

    // Title
    pdf.setFontSize(18);
    const title = patternName.trim()
      ? `${patternName.trim()} — Purl & Plot`
      : "Purl & Plot — Knitting Chart";
    pdf.text(title, pdfMargin, pdfMargin);

    // Chart image
    const maxW = pageW - pdfMargin * 2;
    const maxH = pageH - pdfMargin * 2 - 60;
    const imgScale = Math.min(maxW / chartW, maxH / chartH, 1);
    const imgW = chartW * imgScale;
    const imgH = chartH * imgScale;
    const imgData = canvas.toDataURL("image/png");
    pdf.addImage(imgData, "PNG", pdfMargin, pdfMargin + 30, imgW, imgH);

    // Legend on same page or next
    let legendY = pdfMargin + 30 + imgH + 20;
    const usedStitches = STITCH_SYMBOLS.filter((s) => {
      return grid.some((row) => row.some((c) => c.stitchId === s.id));
    }).filter((s) => s.id !== "none" && s.id !== "knit");

    const usedColors = [...new Set(grid.flat().map((c) => c.color).filter((c) => c !== DEFAULT_BG))];

    if (legendY + 40 > pageH - pdfMargin) {
      pdf.addPage();
      legendY = pdfMargin;
    }

    if (usedStitches.length > 0) {
      pdf.setFontSize(13);
      pdf.text("Stitch Legend", pdfMargin, legendY);
      legendY += 18;
      pdf.setFontSize(10);
      usedStitches.forEach((s) => {
        if (legendY + 14 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
        pdf.text(`${s.symbol}  ${s.name} — ${s.description}`, pdfMargin + 10, legendY);
        legendY += 14;
      });
      legendY += 10;
    }

    if (usedColors.length > 0) {
      if (legendY + 40 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
      pdf.setFontSize(13);
      pdf.text("Color Key", pdfMargin, legendY);
      legendY += 18;
      usedColors.forEach((color) => {
        if (legendY + 16 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
        pdf.setFillColor(parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
        pdf.rect(pdfMargin + 10, legendY - 8, 12, 12, "F");
        pdf.setDrawColor(180);
        pdf.rect(pdfMargin + 10, legendY - 8, 12, 12, "S");
        const colorName = YARN_COLORS.find((c) => c.value === color)?.name ?? color;
        pdf.setFontSize(10);
        pdf.setTextColor(40);
        pdf.text(colorName, pdfMargin + 28, legendY);
        legendY += 16;
      });
    }

    // Pattern notes
    const noteFields: [string, string][] = [
      ["Yarn Weight", patternNotes.yarnWeight],
      ["Yarn Brand", patternNotes.yarnBrand],
      ["Colorway", patternNotes.colorway],
      ["Needle Size", patternNotes.needleSize],
      ["Gauge", patternNotes.gauge],
      ["Finished Size", patternNotes.finishedSize],
    ].filter(([, v]) => v.trim() !== "") as [string, string][];

    const hasAnyNotes = noteFields.length > 0 || patternNotes.notes.trim() !== "";
    if (hasAnyNotes) {
      if (legendY + 60 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
      legendY += 10;
      pdf.setFontSize(13);
      pdf.setTextColor(40);
      pdf.text("Pattern Notes", pdfMargin, legendY);
      legendY += 18;
      pdf.setFontSize(10);
      noteFields.forEach(([label, value]) => {
        if (legendY + 14 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
        pdf.text(`${label}: ${value}`, pdfMargin + 10, legendY);
        legendY += 14;
      });
      if (patternNotes.notes.trim()) {
        legendY += 4;
        const noteLines = pdf.splitTextToSize(patternNotes.notes, maxW - 20);
        noteLines.forEach((line: string) => {
          if (legendY + 14 > pageH - pdfMargin) { pdf.addPage(); legendY = pdfMargin; }
          pdf.text(line, pdfMargin + 10, legendY);
          legendY += 14;
        });
      }
    }

    pdf.save("knitting-pattern.pdf");
    toast({ title: "PDF exported", description: "Chart with legend and notes saved as PDF." });
  }, [grid, rows, cols, patternNotes, patternName, guidelines]);

  const baseCellSize = Math.min(40, Math.floor(1200 / Math.max(rows, cols)));
  const cellSize = Math.round(baseCellSize * zoom);

  return (
    <SidebarProvider defaultOpen={false}>
      <TooltipProvider delayDuration={300}>
        <div className="min-h-screen flex w-full bg-background">
          <AppSidebar
            selectedColor={selectedColor}
            onColorSelect={setSelectedColor}
            selectedStitch={selectedStitch}
            onStitchSelect={setSelectedStitch}
            rows={rows}
            cols={cols}
            onRowsChange={handleRowsChange}
            onColsChange={handleColsChange}
            onClear={handleClear}
            grid={grid}
            onLoad={handleLoadPattern}
            onExportPNG={handleExport}
            onExportPDF={handleExportPDF}
            patternNotes={patternNotes}
            onPatternNotesChange={setPatternNotes}
            patternName={patternName}
            onPatternNameChange={setPatternName}
            guidelines={guidelines}
          />

          <div className="flex-1 flex flex-col min-w-0">
            <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
              <div className="flex items-center gap-2">
                <SidebarTrigger />
                <h1 className="text-lg font-bold text-foreground tracking-tight hidden sm:block" style={{ fontFamily: "'Playfair Display', serif" }}>
                  {t("app.title")}
                </h1>
                <div className="w-px h-6 bg-border hidden sm:block" />
                {/* Drawing Tools */}
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === "paint" ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setActiveTool("paint")}
                      >
                        <Pencil size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.paint")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === "fill" ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setActiveTool("fill")}
                      >
                        <PaintBucket size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.fill")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === "eraser" ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setActiveTool("eraser")}
                      >
                        <Eraser size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.eraser")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === "select" ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setActiveTool("select")}
                      >
                        <MousePointer2 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.select")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="w-px h-5 bg-border" />
                {/* Mirror */}
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={mirrorH ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setMirrorH(!mirrorH)}
                      >
                        <FlipHorizontal2 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.mirrorH")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={mirrorV ? "default" : "ghost"}
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setMirrorV(!mirrorV)}
                      >
                        <FlipVertical2 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.mirrorV")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="w-px h-5 bg-border" />
                {/* Undo/Redo */}
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={undo} disabled={!canUndo}>
                        <Undo2 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.undo")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={redo} disabled={!canRedo}>
                        <Redo2 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.redo")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="w-px h-5 bg-border hidden sm:block" />
                {/* Copy/Paste */}
                <div className="hidden sm:flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleCopy} disabled={!selection}>
                        <Copy size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.copy")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePaste} disabled={!clipboard || !cursorCell}>
                        <ClipboardPaste size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.paste")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleTile} disabled={!selection}>
                        <Grid3X3 size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.tile")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="w-px h-5 bg-border hidden sm:block" />
                {/* Apply Shaping */}
                <div className="hidden sm:flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={applyShaping}>
                        <Wand2 size={14} />
                        <span className="hidden md:inline">{t("tools.applyShaping")}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.applyShapingDesc")}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {/* Zoom */}
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
                        <ZoomOut size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.zoomOut")}</TooltipContent>
                  </Tooltip>
                  <span className="text-[11px] font-medium text-muted-foreground min-w-[3em] text-center">{Math.round(zoom * 100)}%</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
                        <ZoomIn size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.zoomIn")}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="w-px h-5 bg-border" />
                {/* Dark mode toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                    >
                      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{theme === "dark" ? t("tools.lightMode") : t("tools.darkMode")}</TooltipContent>
                </Tooltip>
                {selection && (
                  <span className="rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[11px] font-semibold">
                    <BoxSelect size={10} className="inline mr-0.5" />
                    {Math.abs(selection.endRow - selection.startRow) + 1}×{Math.abs(selection.endCol - selection.startCol) + 1}
                  </span>
                )}
                <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {rows}×{cols}
                </span>
                <HelpButton />
              </div>
            </header>

            <WelcomeDialog />
            <main className="flex-1 flex items-center justify-center p-6 overflow-auto">
              <div className="rounded-xl border border-border bg-card p-6 shadow-sm overflow-auto max-w-full max-h-full">
                <PatternGrid
                  grid={grid}
                  onCellClick={paintCell}
                  onCellDrag={handleCellDrag}
                  onMouseDown={handleMouseDown}
                  onMouseUp={handleMouseUp}
                  cellSize={cellSize}
                  selection={selection}
                  onSelectionChange={setSelection}
                  isSelecting={isSelecting}
                  onSelectStart={handleSelectStart}
                  onSelectMove={handleSelectMove}
                  onSelectEnd={handleSelectEnd}
                  cursorCell={cursorCell}
                  onCursorChange={setCursorCell}
                  activeTool={activeTool}
                  guidelines={guidelines}
                  onGuidelinesChange={setGuidelines}
                />
              </div>
            </main>
          </div>
        </div>
      </TooltipProvider>
    </SidebarProvider>
  );
};

export default Index;
