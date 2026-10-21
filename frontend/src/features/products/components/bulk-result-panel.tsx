'use client';

import React from 'react';
import { X } from 'lucide-react';
import type { BulkResult, Product } from '../types/product.types';

interface BulkResultPanelProps {
  result: BulkResult;
  products: Product[];
  onDismiss: () => void;
}

export default function BulkResultPanel({ result, products, onDismiss }: BulkResultPanelProps) {
  return (
    <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2 relative shadow-sm">
      <button
        onClick={onDismiss}
        className="absolute top-2 right-2 text-slate-400 hover:text-slate-600"
        aria-label="Dismiss results"
      >
        <X className="h-4 w-4" />
      </button>
      <h3 className="text-sm font-bold text-slate-800">Bulk Operation Results</h3>
      <div className="flex gap-4 text-xs font-semibold">
        <span className="text-emerald-700">Successes: {result.successCount}</span>
        <span className={result.failedCount > 0 ? 'text-red-700' : 'text-slate-500'}>
          Failures: {result.failedCount}
        </span>
      </div>
      {result.failures && result.failures.length > 0 && (
        <div className="mt-2 text-xs border-t border-slate-200 pt-2 space-y-1 max-h-40 overflow-y-auto">
          <p className="font-bold text-slate-600">Details of failures:</p>
          <ul className="list-disc pl-4 space-y-1">
            {result.failures.map((failure, idx) => {
              const product = products.find((p) => p.id === failure.id);
              const displayName = product ? `${product.name} (${failure.id})` : failure.id;
              return (
                <li key={idx} className="text-red-600">
                  <span className="font-medium text-slate-700">{displayName}:</span> {failure.message}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
