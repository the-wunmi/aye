/**
 * What's left when the game itself breaks: a way back, not a blank page. A city's interface is
 * written by a model, so something unexpected in it should cost one screen, not the whole app.
 */
import { Component, type ReactNode } from "react";

export class Crashed extends Component<
  { children: ReactNode; onBack(): void },
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="center-screen" role="alert">
        <p>Something broke on our side. Your character is safe.</p>
        <button type="button" className="primary" onClick={this.props.onBack}>
          Back to cities
        </button>
      </div>
    );
  }
}
