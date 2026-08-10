// 顶层：书架 ↔ 阅读器 双视图手写切换（骨架阶段不引入路由库）。

import { LibraryView } from "./components/library/LibraryView";
import { ToastHost } from "./components/common/Toast";
import { ReaderView } from "./components/reader/ReaderView";
import { useReaderStore } from "./store/readerStore";
import "./styles/global.css";

function App() {
  const currentBook = useReaderStore((s) => s.book);

  return (
    <>
      {currentBook ? <ReaderView /> : <LibraryView />}
      <ToastHost />
    </>
  );
}

export default App;