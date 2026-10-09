import { X, ExternalLink } from 'lucide-react';

interface PdfPreviewProps {
  filename: string;
  basePath: string; // e.g. '/receipts' or '/bank-statements/Raiffeisen'
  onClose: () => void;
}

export function PdfPreview({ filename, basePath, onClose }: PdfPreviewProps) {
  const url = `${basePath}/${encodeURIComponent(filename)}`;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="w-[55%] min-w-[480px] bg-background flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
          <span className="text-sm font-medium text-foreground truncate max-w-[80%]" title={filename}>
            {filename}
          </span>
          <div className="flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* PDF iframe */}
        <iframe
          src={url}
          className="flex-1 w-full border-0"
          title={filename}
        />
      </div>
    </div>
  );
}
