import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';

function currentTheme(): 'light' | 'dark' {
  try {
    if (document.documentElement.dataset.theme === 'dark') return 'dark';
  } catch {
    /* ignore */
  }
  return 'light';
}

interface YamlEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  height?: string;
}

/** YAML editor with IDE-style syntax highlighting, line numbers and theme support. */
export function YamlEditor({ id, value, onChange, height = '480px' }: YamlEditorProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);

  useEffect(() => {
    setTheme(currentTheme());
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div id={id} data-ref="yaml-editor" style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
      <CodeMirror
        value={value}
        height={height}
        theme={theme}
        extensions={[yaml()]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          tabSize: 2,
        }}
        onChange={(val) => onChange(val)}
        style={{ fontSize: 'var(--font-size-md)', textAlign: 'left' }}
      />
    </div>
  );
}
