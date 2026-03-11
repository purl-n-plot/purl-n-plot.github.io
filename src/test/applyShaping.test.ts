import { describe, it, expect } from "vitest";
import { CellData, getStitchSpan, getStitchNetChange } from "@/lib/stitchSymbols";

const DEFAULT_BG = "#F5F0EB";

function createEmptyCell(): CellData {
  return { color: DEFAULT_BG, stitchId: "knit" };
}

function createGrid(rows: number, cols: number): CellData[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => createEmptyCell())
  );
}

function placeStitch(grid: CellData[][], row: number, col: number, stitchId: string, color: string): boolean {
  const span = getStitchSpan(stitchId);
  const rowData = grid[row];
  if (col + span > rowData.length) return false;
  rowData[col] = { color, stitchId, spanOwner: span > 1 ? col : undefined };
  for (let i = 1; i < span; i++) {
    rowData[col + i] = { color, stitchId: "none", spanOwner: col };
  }
  return true;
}

function applyShaping(grid: CellData[][]): { result: CellData[][]; totalCols: number } {
  const numRows = grid.length;
  if (numRows === 0) return { result: grid, totalCols: 0 };

  const rowInfo = grid.map((row) => {
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
    const shapingBias = totalShaping === 0 ? 0 : (rightShaping - leftShaping) / totalShaping;

    return { activeCells, oldColToActive, netChange, cellCount: activeCells.length, shapingBias };
  });

  // Bottom row is baseline
  const expectedCounts = new Array(numRows);
  expectedCounts[numRows - 1] = rowInfo[numRows - 1].cellCount;
  let maxWidth = expectedCounts[numRows - 1];

  for (let i = numRows - 2; i >= 0; i--) {
    expectedCounts[i] = expectedCounts[i + 1] + rowInfo[i].netChange;
    maxWidth = Math.max(maxWidth, expectedCounts[i]);
  }

  // Idempotency check
  let alreadyApplied = true;
  for (let i = 0; i < numRows; i++) {
    if (rowInfo[i].cellCount !== expectedCounts[i]) {
      alreadyApplied = false;
      break;
    }
  }
  if (alreadyApplied) {
    return { result: grid, totalCols: grid[0]?.length ?? 0 };
  }

  const currentCols = grid[0]?.length ?? 0;
  const totalCols = Math.max(currentCols, maxWidth);
  const noStitch = (): CellData => ({ color: DEFAULT_BG, stitchId: "none" });

  // Cumulative bias
  const biases = new Array(numRows).fill(0);
  let lastBias = 0;
  for (let i = numRows - 1; i >= 0; i--) {
    if (rowInfo[i].netChange !== 0) {
      lastBias = rowInfo[i].shapingBias;
    }
    biases[i] = lastBias;
  }

  const result = grid.map((_, rowIdx) => {
    const { activeCells, oldColToActive } = rowInfo[rowIdx];
    const expected = expectedCounts[rowIdx];
    const bias = biases[rowIdx];

    let usedCells = activeCells;
    let usedOldColToActive = oldColToActive;
    if (activeCells.length > expected) {
      const excess = activeCells.length - expected;
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

  return { result, totalCols };
}

function countActive(row: CellData[]): number {
  let count = 0;
  for (const cell of row) {
    if (cell.stitchId !== "none") count++;
  }
  return count;
}

describe("Apply Shaping", () => {
  it("does nothing on a uniform grid", () => {
    const grid = createGrid(3, 6);
    const { result } = applyShaping(grid);
    expect(result.length).toBe(3);
    for (const row of result) {
      expect(row.length).toBe(6);
      expect(row.every((c) => c.stitchId === "knit")).toBe(true);
    }
  });

  it("bottom row is baseline and not trimmed", () => {
    const grid = createGrid(3, 6);
    placeStitch(grid, 2, 0, "k2tog", "#FFF"); // bottom row only, net -1
    // Bottom is baseline — nothing changes since only bottom has shaping
    const { result } = applyShaping(grid);
    expect(countActive(result[2])).toBe(6);
    expect(countActive(result[1])).toBe(6);
    expect(countActive(result[0])).toBe(6);
  });

  it("narrows rows above when non-bottom row has decrease", () => {
    const grid = createGrid(3, 6);
    placeStitch(grid, 1, 0, "k2tog", "#FFF"); // middle row, net -1
    const { result } = applyShaping(grid);
    expect(countActive(result[2])).toBe(6); // baseline
    expect(countActive(result[1])).toBe(5); // 6 + (-1) = 5
    expect(countActive(result[0])).toBe(5); // 5 + 0 = 5
  });

  it("expands grid for increase on non-bottom row", () => {
    const grid = createGrid(3, 4);
    placeStitch(grid, 1, 1, "yo", "#FFF"); // middle row net +1
    const { result, totalCols } = applyShaping(grid);
    expect(totalCols).toBeGreaterThanOrEqual(5);
    expect(countActive(result[1])).toBe(5); // 4 + 1 = 5
    expect(countActive(result[0])).toBe(5);
  });

  it("preserves stitches after shaping", () => {
    const grid = createGrid(2, 6);
    placeStitch(grid, 0, 2, "purl", "#FF0000");
    placeStitch(grid, 1, 0, "yo", "#FFF");
    const { result } = applyShaping(grid);
    const hasPurl = result[0].some((c) => c.stitchId === "purl" && c.color === "#FF0000");
    expect(hasPurl).toBe(true);
  });

  it("handles mixed increases and decreases", () => {
    const grid = createGrid(3, 6);
    placeStitch(grid, 1, 0, "yo", "#FFF");   // middle: net +1
    placeStitch(grid, 0, 0, "k2tog", "#FFF"); // top: net -1
    const { result } = applyShaping(grid);
    expect(countActive(result[2])).toBe(6); // baseline
    expect(countActive(result[1])).toBe(7); // 6 + 1 = 7
    expect(countActive(result[0])).toBe(6); // 7 + (-1) = 6
  });

  it("no-stitch cells from previous shaping are stripped", () => {
    const grid = createGrid(2, 6);
    grid[0][0] = { color: DEFAULT_BG, stitchId: "none" };
    grid[0][5] = { color: DEFAULT_BG, stitchId: "none" };
    const { result } = applyShaping(grid);
    const topActive = countActive(result[0]);
    expect(topActive).toBe(6);
  });

  it("is idempotent — re-applying produces same result", () => {
    const grid = createGrid(3, 6);
    placeStitch(grid, 1, 0, "yo", "#FFF"); // middle row increase
    const { result: first } = applyShaping(grid);
    const { result: second } = applyShaping(first);
    for (let r = 0; r < first.length; r++) {
      expect(countActive(second[r])).toBe(countActive(first[r]));
    }
  });

  it("biases padding to the side with shaping stitches", () => {
    const grid = createGrid(2, 6);
    placeStitch(grid, 0, 5, "k2tog", "#FFF"); // top row, right side, net -1
    const { result } = applyShaping(grid);
    const topRow = result[0];
    expect(countActive(topRow)).toBe(5); // 6 + (-1) = 5
    expect(topRow[topRow.length - 1].stitchId).toBe("none");
  });
});
