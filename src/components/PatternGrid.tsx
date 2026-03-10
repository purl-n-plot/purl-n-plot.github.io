import { useCallback, useState, useRef, useMemo } from "react";
import { CellData, getStitchSpan, getStitchNetChange } from "@/lib/stitchSymbols";
import { STITCH_ICON_MAP } from "@/components/StitchIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface Guidelines {
  rows: number[]; // row indices where a guideline is drawn BELOW the row
  cols: number[]; // col indices where a guideline is drawn to the RIGHT of the col
}

export function normalizeSelection(sel: Selection) {
  return {
    minRow: Math.min(sel.startRow, sel.endRow),
    maxRow: Math.max(sel.startRow, sel.endRow),
    minCol: Math.min(sel.startCol, sel.endCol),
    maxCol: Math.max(sel.startCol, sel.endCol),
  };
}

interface PatternGridProps {
  grid: CellData[][];
  onCellClick: (row: number, col: number) => void;
  onCellDrag: (row: number, col: number) => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
  cellSize: number;
  selection: Selection | null;
  onSelectionChange: (sel: Selection | null) => void;
  isSelecting: boolean;
  onSelectStart: (row: number, col: number) => void;
  onSelectMove: (row: number, col: number) => void;
  onSelectEnd: () => void;
  cursorCell: { row: number; col: number } | null;
  onCursorChange: (cell: { row: number; col: number } | null) => void;
  activeTool: "paint" | "fill" | "select" | "eraser";
  guidelines: Guidelines;
  onGuidelinesChange: (g: Guidelines) => void;
}

function isLight(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function isCellInSelection(row: number, col: number, sel: Selection | null): boolean {
  if (!sel) return false;
  const { minRow, maxRow, minCol, maxCol } = normalizeSelection(sel);
  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

const PatternGrid = ({
  grid,
  onCellClick,
  onCellDrag,
  onMouseDown,
  onMouseUp,
  cellSize,
  selection,
  onSelectionChange,
  isSelecting,
  onSelectStart,
  onSelectMove,
  onSelectEnd,
  cursorCell,
  onCursorChange,
  activeTool,
  guidelines,
  onGuidelinesChange,
}: PatternGridProps) => {
  const guideRowSet = useMemo(() => new Set(guidelines.rows), [guidelines.rows]);
  const guideColSet = useMemo(() => new Set(guidelines.cols), [guidelines.cols]);

  const toggleRowGuideline = useCallback(
    (rowIdx: number) => {
      const newRows = guideRowSet.has(rowIdx)
        ? guidelines.rows.filter((r) => r !== rowIdx)
        : [...guidelines.rows, rowIdx];
      onGuidelinesChange({ ...guidelines, rows: newRows });
    },
    [guidelines, guideRowSet, onGuidelinesChange]
  );

  const toggleColGuideline = useCallback(
    (colIdx: number) => {
      const newCols = guideColSet.has(colIdx)
        ? guidelines.cols.filter((c) => c !== colIdx)
        : [...guidelines.cols, colIdx];
      onGuidelinesChange({ ...guidelines, cols: newCols });
    },
    [guidelines, guideColSet, onGuidelinesChange]
  );

  const handleMouseDown = useCallback(
    (row: number, col: number, e: React.MouseEvent) => {
      onCursorChange({ row, col });
      if (activeTool === "select" || e.shiftKey) {
        e.preventDefault();
        onSelectionChange(null);
        onSelectStart(row, col);
      } else {
        onSelectionChange(null);
        onMouseDown();
        onCellClick(row, col);
      }
    },
    [onMouseDown, onCellClick, onSelectStart, onSelectionChange, onCursorChange, activeTool]
  );

  const handleMouseEnter = useCallback(
    (row: number, col: number) => {
      if (isSelecting) {
        onSelectMove(row, col);
      } else {
        onCellDrag(row, col);
      }
    },
    [isSelecting, onSelectMove, onCellDrag]
  );

  const handleMouseUp = useCallback(() => {
    if (isSelecting) {
      onSelectEnd();
    } else {
      onMouseUp();
    }
  }, [isSelecting, onSelectEnd, onMouseUp]);

  const colCount = grid[0]?.length || 0;
  const rowCount = grid.length;

  const rowStats = useMemo(() => {
    const stats = grid.map((row) => {
      let activeCount = 0;
      let netChange = 0;
      let colIdx = 0;
      while (colIdx < row.length) {
        const cell = row[colIdx];
        if (cell.spanOwner !== undefined && cell.spanOwner !== colIdx) {
          colIdx++;
          continue;
        }
        if (cell.stitchId !== "none") {
          activeCount += Math.max(1, getStitchSpan(cell.stitchId));
        }
        netChange += getStitchNetChange(cell.stitchId);
        const span = getStitchSpan(cell.stitchId);
        colIdx += Math.max(1, span);
      }
      return { activeCount, netChange, expectedCount: 0, mismatch: false };
    });

    if (stats.length > 0) {
      const lastIdx = stats.length - 1;
      stats[lastIdx].expectedCount = stats[lastIdx].activeCount + stats[lastIdx].netChange;
      for (let i = lastIdx - 1; i >= 0; i--) {
        stats[i].expectedCount = stats[i + 1].expectedCount + stats[i].netChange;
        stats[i].mismatch = stats[i].activeCount !== stats[i].expectedCount;
      }
    }

    return stats;
  }, [grid]);

  const guidelineColor = "hsl(var(--primary))";
  const guidelineWidth = 2.5;

  return (
    <div className="inline-block select-none">
      <div className="flex">
        {/* Grid area */}
        <div
          className="inline-block border border-border rounded-sm overflow-hidden relative"
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {grid.map((row, rowIdx) => {
            const cells: React.ReactNode[] = [];
            let colIdx = 0;

            while (colIdx < colCount) {
              const cell = row[colIdx];

              if (cell.spanOwner !== undefined && cell.spanOwner !== colIdx) {
                colIdx++;
                continue;
              }

              const currentCol = colIdx;
              const span = getStitchSpan(cell.stitchId);
              const actualSpan = Math.min(span, colCount - currentCol);
              const totalWidth = cellSize * actualSpan;
              const isNoStitch = cell.stitchId === "none" && (cell.spanOwner === undefined || cell.spanOwner === currentCol);
              const bgColor = isNoStitch ? "#C8C4BE" : cell.color;
              const iconSize = Math.max(8, Math.floor(cellSize * 0.7));
              const light = isLight(bgColor);
              const iconColor = light ? "#3A3A3A" : "#F5F0EB";
              const IconComponent = STITCH_ICON_MAP[cell.stitchId];
              const showIcon = (isNoStitch || (cell.stitchId !== "none" && cell.stitchId !== "knit")) && IconComponent;

              let inSelection = false;
              for (let i = 0; i < actualSpan; i++) {
                if (isCellInSelection(rowIdx, currentCol + i, selection)) {
                  inSelection = true;
                  break;
                }
              }

              const isCursor = cursorCell?.row === rowIdx && cursorCell?.col === currentCol;

              // Check if guideline borders apply
              const hasGuideBottom = guideRowSet.has(rowIdx);
              // Check if any col in span has a right guideline
              let hasGuideRight = false;
              for (let i = 0; i < actualSpan; i++) {
                if (guideColSet.has(currentCol + i)) {
                  hasGuideRight = true;
                  break;
                }
              }

              cells.push(
                <div
                  key={`${rowIdx}-${currentCol}`}
                  className="cursor-pointer transition-colors duration-75 hover:brightness-90 flex items-center justify-center"
                  style={{
                    width: totalWidth,
                    height: cellSize,
                    backgroundColor: bgColor,
                    display: "inline-flex",
                    borderRight: "0.5px solid hsl(var(--border) / 0.4)",
                    borderBottom: "0.5px solid hsl(var(--border) / 0.4)",
                    position: "relative",
                  }}
                  onMouseDown={(e) => handleMouseDown(rowIdx, currentCol, e)}
                  onMouseEnter={() => handleMouseEnter(rowIdx, currentCol)}
                >
                  {actualSpan > 1 && Array.from({ length: actualSpan - 1 }, (_, i) => (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0"
                      style={{
                        left: cellSize * (i + 1),
                        width: "0.5px",
                        backgroundColor: "hsl(var(--border) / 0.2)",
                      }}
                    />
                  ))}
                  {showIcon && (
                    <IconComponent
                      size={iconSize}
                      color={iconColor}
                      // @ts-ignore
                      width={actualSpan > 1 ? totalWidth * 0.85 : undefined}
                    />
                  )}
                  {inSelection && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        backgroundColor: "hsl(var(--primary) / 0.25)",
                        border: "1.5px solid hsl(var(--primary) / 0.6)",
                      }}
                    />
                  )}
                  {isCursor && !inSelection && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        border: "2px dashed hsl(var(--primary) / 0.5)",
                      }}
                    />
                  )}
                  {/* Guideline overlays */}
                  {hasGuideBottom && (
                    <div
                      className="absolute left-0 right-0 pointer-events-none"
                      style={{
                        bottom: -guidelineWidth / 2,
                        height: guidelineWidth,
                        backgroundColor: guidelineColor,
                        zIndex: 10,
                      }}
                    />
                  )}
                  {hasGuideRight && (
                    <div
                      className="absolute top-0 bottom-0 pointer-events-none"
                      style={{
                        right: -guidelineWidth / 2,
                        width: guidelineWidth,
                        backgroundColor: guidelineColor,
                        zIndex: 10,
                      }}
                    />
                  )}
                </div>
              );

              colIdx += actualSpan;
            }

            return (
              <div key={rowIdx} className="flex" style={{ height: cellSize }}>
                {cells}
              </div>
            );
          })}
        </div>
        {/* Row numbers + stitch count validation on right */}
        <div className="flex flex-col ml-1.5" style={{ fontSize: Math.max(10, cellSize * 0.4) }}>
          {grid.map((_, rowIdx) => {
            const { activeCount, netChange, expectedCount, mismatch } = rowStats[rowIdx];
            const hasShaping = netChange !== 0;
            const changeLabel = netChange > 0 ? `+${netChange}` : `${netChange}`;
            const hasGuide = guideRowSet.has(rowIdx);

            return (
              <div
                key={rowIdx}
                className="flex items-center gap-1 font-medium"
                style={{ height: cellSize, minWidth: "1.5em" }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-pointer hover:underline select-none"
                      style={{
                        color: hasGuide ? guidelineColor : undefined,
                        fontWeight: hasGuide ? 700 : undefined,
                      }}
                      onClick={() => toggleRowGuideline(rowIdx)}
                    >
                      {rowCount - rowIdx}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-xs">
                    {hasGuide ? "Remove guideline" : "Add guideline"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="leading-none font-semibold rounded px-0.5 cursor-default"
                      style={{
                        fontSize: Math.max(8, cellSize * 0.32),
                        color: mismatch
                          ? "hsl(var(--destructive))"
                          : hasShaping
                            ? netChange > 0 ? "hsl(var(--chart-4))" : "hsl(var(--destructive))"
                            : "hsl(var(--foreground) / 0.5)",
                        backgroundColor: mismatch
                          ? "hsl(var(--destructive) / 0.15)"
                          : hasShaping
                            ? netChange > 0 ? "hsl(var(--chart-4) / 0.15)" : "hsl(var(--destructive) / 0.15)"
                            : "transparent",
                      }}
                    >
                      {mismatch ? `⚠${activeCount}` : activeCount}
                      {hasShaping && !mismatch ? ` ${changeLabel}` : ""}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-xs">
                    {mismatch
                      ? `Row has ${activeCount} active sts, expected ${expectedCount} (based on previous row + shaping)`
                      : `${activeCount} active sts${hasShaping ? ` • net ${changeLabel} (${netChange > 0 ? "increase" : "decrease"})` : ""}`
                    }
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
      {/* Column numbers at bottom (right-to-left) */}
      <div className="flex mt-1.5" style={{ fontSize: Math.max(10, cellSize * 0.4) }}>
        {Array.from({ length: colCount }, (_, colIdx) => (
          <Tooltip key={colIdx}>
            <TooltipTrigger asChild>
              <div
                className="text-center font-medium cursor-pointer hover:underline select-none"
                style={{
                  width: cellSize,
                  color: guideColSet.has(colIdx) ? guidelineColor : undefined,
                  fontWeight: guideColSet.has(colIdx) ? 700 : undefined,
                }}
                onClick={() => toggleColGuideline(colIdx)}
              >
                {colCount - colIdx}
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {guideColSet.has(colIdx) ? "Remove guideline" : "Add guideline"}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
};

export default PatternGrid;
