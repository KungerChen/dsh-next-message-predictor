// DSH's overlay receives InputActions, but its public interface has no
// undo-history preparation method. Keep the Lexical DOM bridge here.

const NMP_LEXICAL_HISTORY_VERSION = '0.49.0+prod.esm'

function nmpSelectionPoints(input) {
  const selection = input.ownerDocument.getSelection()
  return selection === null ? [] : [
    selection.anchorNode,
    selection.anchorOffset,
    selection.focusNode,
    selection.focusOffset,
    selection.rangeCount,
  ]
}

/**
 * After a send, Lexical clears the undo stack and its current snapshot. Merge
 * the already committed empty draft into history before the native paste-tagged
 * insertion, so that insertion has a state to which it can be undone.
 */
export function nmpPrepareComposerUndo(input, verifyInsertion) {
  let editor
  try {
    editor = input.__lexicalEditor
    if (editor?.constructor?.version !== NMP_LEXICAL_HISTORY_VERSION) return true
    if (typeof editor.getRootElement !== 'function' || typeof editor.getEditorState !== 'function' ||
      typeof editor.isEditable !== 'function' || typeof editor.isComposing !== 'function' ||
      typeof editor.read !== 'function' || typeof editor.update !== 'function' ||
      typeof input.ownerDocument?.getSelection !== 'function') return true
  } catch {
    return true
  }

  const editorIsCurrent = () => input.__lexicalEditor === editor && editor.getRootElement() === input &&
    editor.isEditable() === true && editor.isComposing() === false
  try {
    if (!editorIsCurrent()) return false
    // Commit pending user edits with their original tags before adding ours.
    editor.read('force-commit', () => {})
    if (!editorIsCurrent() || !verifyInsertion()) return false
    // Lexical cannot restore a state that contains only its root and no selection.
    if (editor.getEditorState()?.isEmpty?.() !== false) return true

    const beforeSelection = nmpSelectionPoints(input)
    let committed = false
    editor.update(() => {}, {
      discrete: true,
      skipTransforms: true,
      tag: ['history-merge', 'skip-dom-selection'],
      // Lexical only commits an unchanged editor state if a callback is pending.
      onUpdate: () => { committed = true },
    })
    const afterSelection = nmpSelectionPoints(input)
    return committed && editorIsCurrent() && beforeSelection.length === afterSelection.length &&
      beforeSelection.every((value, index) => value === afterSelection[index]) && verifyInsertion()
  } catch {
    return false
  }
}
