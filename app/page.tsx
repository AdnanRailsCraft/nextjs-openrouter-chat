import { Suspense } from 'react';
import PageContent from './page-content';

export default function Home() {
  return (
    <Suspense fallback={<div className="h-screen w-full bg-gray-50 flex items-center justify-center">Loading...</div>}>
      <PageContent />
    </Suspense>
  );
}
