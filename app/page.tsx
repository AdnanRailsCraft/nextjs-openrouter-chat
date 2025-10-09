import Chat from './components/Chat';

export default function Home() {
  return (
    <main className="min-h-screen bg-white">
      <div className="container mx-auto px-4">
        <header className="py-6 text-center">
          <h1 className="text-2xl font-bold mb-2">AI Chat Assistant</h1>
          <p className="text-gray-600">Powered by Qwen-2.5 Model</p>
        </header>
        <Chat />
      </div>
    </main>
  );
}
