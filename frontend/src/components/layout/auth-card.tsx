'use client';

import React from 'react';

/**
 * Navy auth card with the Catalog logo header — shared by login, welcome,
 * reset-password and forgot-password so the entry pages read as one app and
 * the white logo has a dark surface to sit on. Inner text uses light colors.
 */
export default function AuthCard({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="px-4">
      <div
        className="max-w-md mx-auto mt-16 rounded-card p-8 shadow-pop bg-gradient-to-b from-[#101623] to-[#1f2937]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/CatalogLogoPrincipal.svg"
          alt="Catalog by Wegox"
          className="h-6 w-auto mx-auto mb-7 select-none"
        />
        {children}
      </div>
    </div>
  );
}
