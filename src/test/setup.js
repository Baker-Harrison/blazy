// Runs once before every test file. Registers jest-dom's extra matchers
// (like toBeInTheDocument) on top of Vitest's built-in expect, so component
// tests can make readable assertions about what's on screen.
import '@testing-library/jest-dom/vitest';
