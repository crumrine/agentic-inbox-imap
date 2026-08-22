// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package backend

import "fmt"

// ErrorKind classifies a backend error so the IMAP layer can map it to the
// correct IMAP response without inspecting HTTP status codes itself.
type ErrorKind int

const (
	// ErrKindUnknown is used for responses that don't fit another kind.
	ErrKindUnknown ErrorKind = iota
	// ErrKindAuthFailed corresponds to a 401 response from the Worker.
	ErrKindAuthFailed
	// ErrKindNotFound corresponds to a 404 response from the Worker.
	ErrKindNotFound
	// ErrKindServer covers 5xx responses and transport-level failures
	// (connection refused, DNS failure, non-timeout network errors, etc).
	ErrKindServer
)

func (k ErrorKind) String() string {
	switch k {
	case ErrKindAuthFailed:
		return "auth failed"
	case ErrKindNotFound:
		return "not found"
	case ErrKindServer:
		return "server error"
	default:
		return "unknown"
	}
}

// APIError is returned by Client methods for any non-success response from
// the Worker, or for a transport-level failure while talking to it.
//
// It intentionally never carries request bodies, headers, or credentials —
// only the HTTP status code, a classification, and (for HTTP responses) a
// short excerpt of the response body for diagnostics.
type APIError struct {
	Kind       ErrorKind
	StatusCode int // 0 for transport-level errors that never got a response
	Body       string
	Err        error // underlying transport error, if any
}

func (e *APIError) Error() string {
	if e.StatusCode == 0 {
		return fmt.Sprintf("backend: %s: %v", e.Kind, e.Err)
	}
	if e.Body != "" {
		return fmt.Sprintf("backend: %s (HTTP %d): %s", e.Kind, e.StatusCode, e.Body)
	}
	return fmt.Sprintf("backend: %s (HTTP %d)", e.Kind, e.StatusCode)
}

func (e *APIError) Unwrap() error {
	return e.Err
}

// Is supports errors.Is against the package sentinel errors below, so
// callers can write errors.Is(err, backend.ErrAuthFailed) instead of type
// switching on *APIError.
func (e *APIError) Is(target error) bool {
	switch target {
	case ErrAuthFailed:
		return e.Kind == ErrKindAuthFailed
	case ErrNotFound:
		return e.Kind == ErrKindNotFound
	case ErrServer:
		return e.Kind == ErrKindServer
	}
	return false
}

// Sentinel errors for use with errors.Is. They are never returned directly;
// APIError.Is matches against them based on Kind.
var (
	ErrAuthFailed = fmt.Errorf("backend: auth failed")
	ErrNotFound   = fmt.Errorf("backend: not found")
	ErrServer     = fmt.Errorf("backend: server error")
)
