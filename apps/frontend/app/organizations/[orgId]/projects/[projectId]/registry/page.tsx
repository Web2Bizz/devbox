'use client';

function SubPage({ title }: { title: string }) {
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
    </div>
  );
}

export default function NestedRegistryPage() {
  return <SubPage title="Registry" />;
}
