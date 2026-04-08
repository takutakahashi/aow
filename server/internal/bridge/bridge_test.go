package bridge_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/takutakahashi/aow/server/internal/bridge"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

// echoServer starts an httptest.Server that bridges every WS connection to
// a simple inline echo agent: reads one NDJSON line, echoes it back with
// {"jsonrpc":"2.0","id":1,"result":{}} so we can verify the bridge works.
func newBridgeServer(t *testing.T, command string, args ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade: %v", err)
			return
		}
		go bridge.Handle(conn, bridge.Config{Command: command, Args: args})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestBridge_InitializeRoundTrip(t *testing.T) {
	// Use the compiled echo-agent from client/dist if available, otherwise skip.
	agentPath := "../../../client/dist/examples/echo-agent.js"
	if _, err := os.Stat(agentPath); err != nil {
		t.Skipf("echo-agent not built: %v", err)
	}

	srv := newBridgeServer(t, "node", agentPath)

	conn, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	req := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":0,"clientCapabilities":{}}}`
	if err := conn.WriteMessage(websocket.TextMessage, []byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	if !strings.Contains(string(msg), `"echo-agent"`) {
		t.Errorf("unexpected response: %s", msg)
	}
}
