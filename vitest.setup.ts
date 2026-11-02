import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { useUnreviewedSuggestions } from './src/features/writing/unreviewedSuggestions';

afterEach(() => {
  cleanup();
  // 会话内 store 是模块级单例；用例之间必须清掉，否则未审阅标记会串味
  useUnreviewedSuggestions.setState({ items: {} });
});
