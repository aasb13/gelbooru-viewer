import QtQuick
import qs.Common
import qs.Modules.Plugins

DashTabComponent {
    id: root

    implicitHeight: gallery.implicitHeight + Theme.spacingM * 2

    GelbooruGallery {
        id: gallery

        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Theme.spacingM

        posts: pluginData.posts ?? []
        query: pluginData.query ?? ""
        page: pluginData.page ?? 0
        totalPages: pluginData.totalPages ?? 0
        loading: pluginData.loading ?? false
        fetchTick: pluginData.fetchTick ?? 0
        columns: pluginData.gridColumns ?? 3
        mutate: (key, value) => root.setData(key, value)
    }
}
