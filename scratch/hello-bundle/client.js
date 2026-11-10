/**
 * Client half of the `predictor-hello` P0 load-proof bundle.
 *
 * Registers a small marker under the conversation composer. Its DOM node
 * (data-testid="predictor-hello-marker") is the browser-side proof that the
 * Client module was downloaded, loaded and registered into a live slot.
 */
window.__ModuleLoader__.load({
  id: 'predictor-hello',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function HelloMarker() {
      return h(
        'div',
        {
          'data-testid': 'predictor-hello-marker',
          role: 'status',
          title: 'predictor-hello bundle loaded (P0 load proof)',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            marginTop: '4px',
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '16px',
            fontWeight: 600,
            color: '#247bbf',
            background: 'rgba(36, 123, 191, 0.12)',
            pointerEvents: 'none',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '999px',
            background: '#247bbf',
          },
        }),
        'predictor-hello',
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        globalThis.__PREDICTOR_HELLO__ = {
          loaded: true,
          moduleId: 'predictor-hello',
          // Empirically: this DSH build renders conversation.input.dock in the
          // new-session composer, while conversation.composer.dock is rendered
          // only for an existing session conversation.
          slot: 'conversation.input.dock',
          loadedAt: new Date().toISOString(),
        };
        ctx.effect(() => () => {
          delete globalThis.__PREDICTOR_HELLO__;
        });
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'predictor-hello',
              order: 5,
            },
            HelloMarker,
          ),
        );
      },
    };
  },
});
