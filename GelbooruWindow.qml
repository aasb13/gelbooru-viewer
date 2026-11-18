import QtQuick
import Quickshell
import qs.Common

FloatingWindow {
    id: root

    property var posts: []
    property string query: ""
    property int page: 0
    property int totalPages: 0
    property bool loading: false
    property int fetchTick: 0
    property int columns: 3
    property var mutate: null

    title: "Gelbooru"
    color: Theme.floatingWindowSurface
    minimumSize: Qt.size(640, 480)
    width: 960
    height: 680

    GelbooruGallery {
        anchors.fill: parent
        anchors.margins: Theme.spacingM

        posts: root.posts
        query: root.query
        page: root.page
        totalPages: root.totalPages
        loading: root.loading
        fetchTick: root.fetchTick
        columns: root.columns
        mutate: root.mutate
        baseColor: Theme.floatingWindowSurface
    }
}
