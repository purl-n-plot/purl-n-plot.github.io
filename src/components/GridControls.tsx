import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GridControlsProps {
  rows: number;
  cols: number;
  onRowsChange: (rows: number) => void;
  onColsChange: (cols: number) => void;
  onClear: () => void;
}

const clampGrid = (val: number) => Math.max(4, Math.min(200, val));

const NumberStepper = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) => {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  const commit = () => {
    const parsed = parseInt(draft, 10);
    if (!isNaN(parsed)) {
      onChange(clampGrid(parsed));
    }
    setDraft(String(clampGrid(!isNaN(parsed) ? parsed : value)));
    setEditing(false);
  };

  if (!editing && draft !== String(value)) {
    setDraft(String(value));
  }

  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onChange(clampGrid(value - 1))}
        >
          <Minus size={14} />
        </Button>
        <Input
          className="w-12 h-7 text-center text-sm font-medium p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          type="number"
          min={4}
          max={200}
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setEditing(true);
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onChange(clampGrid(value + 1))}
        >
          <Plus size={14} />
        </Button>
      </div>
    </div>
  );
};

const GridControls = ({
  rows,
  cols,
  onRowsChange,
  onColsChange,
  onClear,
}: GridControlsProps) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground" style={{ fontFamily: "'Playfair Display', serif" }}>{t("grid.gridSize")}</h3>
      <div className="space-y-2">
        <NumberStepper label={t("grid.columns")} value={cols} onChange={onColsChange} />
        <NumberStepper label={t("grid.rows")} value={rows} onChange={onRowsChange} />
      </div>

      <Button variant="destructive" className="w-full gap-2" onClick={onClear}>
        <Trash2 size={16} />
        {t("grid.clearGrid")}
      </Button>
    </div>
  );
};

export default GridControls;
